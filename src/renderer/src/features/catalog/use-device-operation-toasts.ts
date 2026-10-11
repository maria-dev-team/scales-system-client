import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import type {
  CatalogState,
  ClearPluJob,
  UploadJob,
} from '../../../../shared/catalog';

type Operation = UploadJob | ClearPluJob;
type Notification = {
  kind: 'loading' | 'success' | 'warning' | 'error';
  title: string;
  description: string;
};
type Observed = { id: string; signature: string; loading: boolean };
type Observer = {
  initialized: boolean;
  jobs: Map<'upload' | 'clear', Observed>;
};

export function isDeviceOperationRunning(job: Operation | null): boolean {
  return Boolean(job && (job.status === 'running' || !job.finishedAt));
}

function notification(job: Operation): Notification {
  const target = `${job.device.scaleIp}:${job.device.port}`;
  if ('items' in job) {
    const acknowledged = job.items.filter(
      (item) => item.state === 'acknowledged',
    ).length;
    const progress = `Подтверждено товаров: ${acknowledged}/${job.items.length}`;
    if (isDeviceOperationRunning(job))
      return {
        kind: 'loading',
        title: 'Загружаем товары на весы…',
        description: `${target} · ${progress}. ${job.status === 'running' ? 'Ожидаем ответ весов.' : 'Завершаем связь с весами.'}`,
      };
    if (job.status === 'cancelled' || job.status === 'interrupted')
      return {
        kind: 'warning',
        title:
          job.status === 'cancelled'
            ? 'Загрузка остановлена'
            : 'Загрузка прервана',
        description: `${target} · ${progress}. Уже переданные товары остаются на весах. Проверьте результат перед повторной отправкой.`,
      };
    if (job.status === 'failed' || job.error)
      return {
        kind: 'error',
        title: 'Ошибка загрузки на весы',
        description:
          job.error ?? `${target} · ${progress}. Проверьте отчёт о загрузке.`,
      };
    if (acknowledged !== job.items.length)
      return {
        kind: 'warning',
        title: 'Не все товары подтверждены весами',
        description: `${target} · ${progress}. Проверьте отчёт перед повторной отправкой.`,
      };
    if (job.disconnectError)
      return {
        kind: 'warning',
        title: 'Загрузка завершена с предупреждением',
        description: `${target} · ${progress}. Завершение связи: ${job.disconnectError}`,
      };
    return {
      kind: 'success',
      title: 'Загрузка завершена',
      description: `${target} · ${progress}.`,
    };
  }
  if (isDeviceOperationRunning(job)) {
    const acknowledged =
      job.commandState === 'acknowledged'
        ? 2
        : new Set(
            job.events
              .filter(
                (event) =>
                  event.kind === 'rx' &&
                  event.hex === '02' &&
                  ['clear:extended', 'clear:base'].includes(event.phase),
              )
              .map((event) => event.phase),
          ).size;
    return {
      kind: 'loading',
      title: 'Удаляем товары с весов…',
      description: `${target} · Подтверждено этапов очистки: ${acknowledged}/2. ${job.commandState === 'acknowledged' ? 'Завершаем связь с весами.' : 'Ожидаем ответ весов.'}`,
    };
  }
  if (job.commandState === 'uncertain' || job.commandState === 'in_flight')
    return {
      kind: 'warning',
      title: 'Результат очистки неизвестен',
      description: `${target} · Очистка могла выполниться частично или полностью. Проверьте товары на весах перед повтором.${job.error ? ` ${job.error}` : ''}`,
    };
  if (job.status === 'cancelled' || job.status === 'interrupted')
    return {
      kind: 'warning',
      title:
        job.status === 'cancelled' ? 'Очистка остановлена' : 'Очистка прервана',
      description: `${target} · ${job.commandState === 'pending' ? 'Команды очистки не отправлены.' : 'Проверьте товары на весах перед повтором.'}`,
    };
  if (
    job.commandState !== 'acknowledged' ||
    job.status !== 'completed' ||
    job.error
  )
    return {
      kind: 'error',
      title: 'Ошибка очистки весов',
      description:
        job.error ?? `${target} · Весы не подтвердили удаление товаров.`,
    };
  if (job.disconnectError)
    return {
      kind: 'warning',
      title: 'Очистка подтверждена, но связь завершилась с ошибкой',
      description: `${target} · ${job.disconnectError}. Проверьте, что старые PLU не вызываются.`,
    };
  return {
    kind: 'success',
    title: 'Очистка завершена',
    description: `${target} · Весы подтвердили команды очистки. Проверьте, что старые PLU не вызываются.`,
  };
}

export function useDeviceOperationToasts(state: CatalogState): void {
  const scope = state.scope;
  const scopeKey = scope
    ? JSON.stringify([
        scope.apiUrl,
        scope.userId,
        scope.membershipId,
        scope.organizationId,
        scope.storeId,
      ])
    : null;
  const observer = useRef<Observer | null>(null);

  useEffect(() => {
    const current: Observer = { initialized: false, jobs: new Map() };
    observer.current = current;
    return () => {
      for (const job of current.jobs.values())
        if (job.loading) toast.dismiss(job.id);
      observer.current = null;
    };
  }, [scopeKey]);

  useEffect(() => {
    const current = observer.current;
    if (!scopeKey || !current) return;
    const jobs = [
      ['upload', state.latestUpload],
      ['clear', state.latestClear],
    ] as const;
    for (const [operation, job] of jobs) {
      const previous = current.jobs.get(operation);
      const id = job ? `catalog-${operation}-${job.id}` : null;
      if (previous?.loading && previous.id !== id) toast.dismiss(previous.id);
      if (!job || !id) {
        current.jobs.delete(operation);
        continue;
      }
      const next = notification(job);
      const signature = JSON.stringify(next);
      const unchanged = previous?.id === id && previous.signature === signature;
      const historical = !current.initialized && next.kind !== 'loading';
      current.jobs.set(operation, {
        id,
        signature,
        loading: next.kind === 'loading',
      });
      if (historical || unchanged) continue;
      toast[next.kind](next.title, {
        id,
        description: next.description,
        duration:
          next.kind === 'loading'
            ? Infinity
            : next.kind === 'success'
              ? 6000
              : 10000,
      });
    }
    current.initialized = true;
  }, [scopeKey, state.latestUpload, state.latestClear]);
}
