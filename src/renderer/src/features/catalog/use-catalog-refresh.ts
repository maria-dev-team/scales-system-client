import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { CatalogState } from '../../../../shared/catalog';
import { catalogErrorMessage } from './catalog-error';

type Attempt = {
  id: string | number;
  previousSync: string | null;
  accepted: boolean;
};

export function useCatalogRefresh(
  state: CatalogState,
  onState: (state: CatalogState) => void,
) {
  const attempt = useRef<Attempt | null>(null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = JSON.stringify(state.scope);

  const finish = useCallback(
    (
      current: Attempt,
      kind: 'success' | 'warning' | 'error',
      title: string,
      description: string,
    ) => {
      if (attempt.current !== current) return;
      attempt.current = null;
      setPending(false);
      setCompleted(kind === 'success');
      if (kind === 'error') setError(description);
      toast[kind](title, {
        id: current.id,
        description,
        duration: kind === 'success' ? 6000 : 10000,
      });
    },
    [],
  );

  const observe = useCallback(
    (next: CatalogState) => {
      const current = attempt.current;
      if (!current?.accepted || next.sync.running) return;
      if (next.sync.phase === 'cancelled') {
        finish(
          current,
          'warning',
          'Обновление остановлено',
          'В приложении остаётся ранее сохранённый каталог.',
        );
      } else if (
        next.sync.phase === 'error' ||
        next.sync.error ||
        next.access === 'none'
      ) {
        finish(
          current,
          'error',
          'Не удалось обновить каталог',
          next.sync.error ??
            next.error ??
            'Войдите в Maria и повторите обновление.',
        );
      } else if (next.access === 'offline') {
        finish(
          current,
          'warning',
          'Не удалось проверить актуальность',
          'Нет соединения с Maria. Сохранённый каталог доступен. Повторите обновление после восстановления связи.',
        );
      } else if (
        next.sync.phase === 'idle' &&
        next.sync.lastSyncedAt &&
        next.sync.lastSyncedAt !== current.previousSync
      ) {
        finish(
          current,
          'success',
          'Каталог актуален',
          `В локальной базе: ${next.total} товаров. Проверено: ${new Date(next.sync.lastSyncedAt).toLocaleString('ru-RU')}.`,
        );
      } else if (next.sync.phase === 'pages' || next.sync.phase === 'changes') {
        finish(
          current,
          'warning',
          'Обновление ещё не завершено',
          'Актуальность каталога пока не подтверждена. Нажмите «Обновить каталог», чтобы продолжить.',
        );
      }
      // An unchanged idle snapshot can be a poll started before the command.
      // Keep waiting for a new completion timestamp instead of ending early.
    },
    [finish],
  );

  useEffect(() => {
    // Do not leave a loading toast belonging to another store or a closed view.
    return () => {
      if (attempt.current) toast.dismiss(attempt.current.id);
      attempt.current = null;
      setPending(false);
      setCompleted(false);
      setError(null);
    };
  }, [scopeKey]);

  useEffect(() => observe(state), [state, observe]);

  const refresh = async (): Promise<void> => {
    const api = window.catalog;
    if (!api || attempt.current) return;
    const current: Attempt = {
      id: toast.loading('Обновляем каталог…', {
        description:
          'Проверяем изменения в Maria и сохраняем товары на компьютере.',
        duration: Infinity,
      }),
      previousSync: state.sync.lastSyncedAt,
      accepted: false,
    };
    attempt.current = current;
    setPending(true);
    setCompleted(false);
    setError(null);
    try {
      const next = await api.request({ type: 'sync' });
      if (attempt.current !== current) return;
      current.accepted = true;
      onState(next);
      // The start ACK is not completion. A new lastSyncedAt also catches a run
      // that finished before the renderer could observe its running phase.
      observe(next);
    } catch (cause) {
      finish(
        current,
        'error',
        'Не удалось обновить каталог',
        catalogErrorMessage(cause),
      );
    }
  };

  return { refresh, pending, completed, error };
}
