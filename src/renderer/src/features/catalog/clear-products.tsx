import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@renderer/common/components/ui/button';

import type {
  CatalogApi,
  CatalogState,
  ClearPluConfirmation,
  ClearPluJob,
  ScaleDevice,
} from '../../../../shared/catalog';
import { isDeviceOperationRunning } from './use-device-operation-toasts';

export function ClearProducts({
  device,
  job,
  api,
  locked,
  pending = null,
  onState,
  run,
  onNotice,
}: {
  device: ScaleDevice | null;
  job: ClearPluJob | null;
  api: CatalogApi;
  locked: boolean;
  pending?: string | null;
  onState: (state: CatalogState) => void;
  run: (action: () => Promise<void>, label?: string) => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [confirmation, setConfirmation] = useState<ClearPluConfirmation | null>(
    null,
  );
  const [agreed, setAgreed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmation) heading.current?.focus();
  }, [confirmation]);
  const dismiss = (): void => {
    setConfirmation(null);
    setAgreed(false);
    trigger.current?.focus();
  };
  const running = isDeviceOperationRunning(job);
  const uncertain =
    job?.commandState === 'uncertain' || job?.commandState === 'in_flight';
  return (
    <section
      className="space-y-5 rounded-xl border border-destructive/25 bg-card p-5 sm:p-6"
      aria-label="Очистка товаров на весах"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && confirmation && !pending) dismiss();
      }}
    >
      <div className="flex items-start gap-3">
        <Trash2
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-destructive"
        />
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Очистка товаров на весах</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Удалите старые товары перед загрузкой нового каталога. Товары в
            Maria и локальная база сохранятся.
          </p>
        </div>
      </div>
      {!device ? (
        <p className="text-sm text-muted-foreground">
          Сначала сохраните подключение к весам.
        </p>
      ) : null}
      {!confirmation ? (
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          className="h-auto min-h-12 whitespace-normal border-destructive/30 text-destructive hover:text-destructive"
          disabled={locked || !device}
          loading={pending === 'Проверяем подключение для очистки…'}
          onClick={() =>
            void run(async () => {
              const next = await api.request({ type: 'prepare-clear' });
              setAgreed(false);
              setConfirmation(next);
            }, 'Проверяем подключение для очистки…')
          }
        >
          Удалить все товары с весов
        </Button>
      ) : (
        <div className="space-y-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <h3
            ref={heading}
            tabIndex={-1}
            className="font-semibold outline-none"
          >
            Удалить все товары с этих весов?
          </h3>
          <p className="text-sm font-semibold tabular-nums">
            {confirmation.device.scaleIp}:{confirmation.device.port}
          </p>
          <p className="text-sm text-muted-foreground">
            Адрес адаптера: {confirmation.device.localAddress}. Используется
            сохранённое подключение.
          </p>
          <p className="text-sm leading-6">
            Будут удалены все товары на устройстве, в том числе загруженные из
            других магазинов и программ. Отменить выполненное удаление нельзя.
            Для восстановления товары потребуется загрузить заново.
          </p>
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-6">
            <input
              type="checkbox"
              checked={agreed}
              disabled={locked}
              onChange={(event) => setAgreed(event.target.checked)}
              className="mt-1 size-4 shrink-0 accent-destructive"
            />
            <span>
              Адрес весов проверен. Подтверждаю удаление всех товаров с этого
              устройства.
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={pending !== null}
              onClick={dismiss}
            >
              Отмена
            </Button>
            <Button
              type="button"
              className="h-auto min-h-12 whitespace-normal bg-destructive text-white shadow-none hover:bg-destructive/90"
              disabled={!agreed || locked}
              loading={pending === 'Запускаем очистку…'}
              onClick={() => {
                const token = confirmation.token;
                void run(async () => {
                  try {
                    onState(
                      await api.request({ type: 'clear-products', token }),
                    );
                  } finally {
                    setConfirmation(null);
                    setAgreed(false);
                  }
                }, 'Запускаем очистку…');
              }}
            >
              Подтвердить удаление всех товаров
            </Button>
          </div>
        </div>
      )}
      {job ? (
        <div
          className="space-y-3 border-t border-border pt-5"
          aria-label="Результат очистки"
        >
          <h3 className="font-semibold">
            {running ? 'Удаляем товары с весов…' : 'Последняя очистка'}
          </h3>
          <p className="text-xs text-muted-foreground">
            {job.device.scaleIp}:{job.device.port} ·{' '}
            {new Date(job.createdAt).toLocaleString('ru-RU')}
          </p>
          <p role="status" className="text-sm leading-6">
            {running
              ? 'Ожидаем ответ весов. Остановка после отправки команды не отменяет удаление.'
              : job.commandState === 'acknowledged'
                ? 'Весы подтвердили команды очистки. Проверьте, что старые PLU не вызываются. Затем можно загрузить каталог заново.'
                : uncertain
                  ? 'Результат неизвестен. Очистка могла выполниться частично или полностью. Проверьте товары на весах перед повтором.'
                  : job.commandState === 'rejected'
                    ? 'Весы отклонили команду очистки.'
                    : 'Команды очистки не отправлены.'}
          </p>
          {job.error ? (
            <p className="text-sm text-destructive">{job.error}</p>
          ) : null}
          {job.disconnectError ? (
            <p className="text-sm text-destructive">
              Завершение связи: {job.disconnectError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {running ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending !== null}
                loading={pending === 'Останавливаем очистку…'}
                onClick={() =>
                  void run(
                    async () =>
                      onState(await api.request({ type: 'cancel-clear' })),
                    'Останавливаем очистку…',
                  )
                }
              >
                Остановить очистку
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-h-12 whitespace-normal"
              disabled={pending !== null}
              loading={pending === 'Сохраняем отчёт об очистке…'}
              onClick={() =>
                void run(async () => {
                  const path = await api.request({ type: 'export-clear' });
                  if (path) onNotice(`Отчёт сохранён: ${path}`);
                }, 'Сохраняем отчёт об очистке…')
              }
            >
              Сохранить отчёт об очистке
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
