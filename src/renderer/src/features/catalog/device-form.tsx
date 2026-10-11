import {
  Barcode,
  CircleAlert,
  ClipboardCheck,
  Network,
  RefreshCw,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@renderer/common/components/ui/button';
import { Input } from '@renderer/common/components/ui/input';

import type { ScaleDevice } from '../../../../shared/catalog';
import type { NetworkAdapter } from '../../../../shared/diagnostics';

const box = 'space-y-5 rounded-xl border border-border bg-card p-5 sm:p-6';
const field = 'grid min-w-0 content-start gap-2 text-sm';
const selectStyle =
  'h-12 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export function DeviceForm({
  device,
  prefix,
  profileEnabled,
  adapters,
  busy,
  saving = false,
  refreshing = false,
  onSave,
  onEdit,
  onRefreshAdapters,
}: {
  device: ScaleDevice | null;
  prefix: string | null;
  profileEnabled: boolean;
  adapters: NetworkAdapter[];
  busy: boolean;
  saving?: boolean;
  refreshing?: boolean;
  onSave: (device: ScaleDevice) => void;
  onEdit: () => void;
  onRefreshAdapters: () => void;
}) {
  const [draft, setDraft] = useState<ScaleDevice>(() => ({
    ...(device ?? {
      scaleIp: '',
      localAddress: '',
      port: 5001,
      nameEncoding: 'windows-1251',
    }),
    barcodePrefix: prefix ?? '',
    setupConfirmed: Boolean(
      prefix && device?.barcodePrefix === prefix && device.setupConfirmed,
    ),
  }));
  const change = (values: Partial<ScaleDevice>): void => {
    setDraft((current) => ({ ...current, ...values }));
    onEdit();
  };
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...draft, scaleIp: draft.scaleIp.trim() });
      }}
    >
      <section className={box} aria-labelledby="scale-connection-title">
        <div className="flex items-start gap-3">
          <Network
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          />
          <div className="space-y-1">
            <h2 id="scale-connection-title" className="text-lg font-semibold">
              Подключение к весам
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Адрес весов и сетевой адаптер этого компьютера.
            </p>
          </div>
        </div>
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <label className={field}>
            <span className="font-medium">IP весов</span>
            <Input
              aria-label="IP весов"
              value={draft.scaleIp}
              onChange={(event) =>
                change({ scaleIp: event.target.value, setupConfirmed: false })
              }
              disabled={busy}
              placeholder="192.168.1.8"
            />
          </label>
          <label className={field}>
            <span className="font-medium">UDP-порт</span>
            <Input
              aria-label="UDP-порт"
              type="number"
              min="1"
              max="65535"
              value={draft.port}
              onChange={(event) =>
                change({
                  port: Number(event.target.value),
                  setupConfirmed: false,
                })
              }
              disabled={busy}
            />
          </label>
        </div>
        <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label className={field}>
            <span className="font-medium">Ethernet-адаптер</span>
            <select
              aria-label="Ethernet-адаптер"
              className={selectStyle}
              value={draft.localAddress}
              disabled={busy}
              onChange={(event) => change({ localAddress: event.target.value })}
            >
              <option value="">Выберите адаптер</option>
              {draft.localAddress &&
              !adapters.some(
                (entry) => entry.address === draft.localAddress,
              ) ? (
                <option value={draft.localAddress}>
                  {draft.localAddress} — недоступен
                </option>
              ) : null}
              {adapters.map((entry) => (
                <option
                  key={`${entry.name}-${entry.address}`}
                  value={entry.address}
                >
                  {entry.name} — {entry.address}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={busy}
            loading={refreshing}
            type="button"
            variant="ghost"
            className="border-border text-sm text-foreground"
            onClick={onRefreshAdapters}
          >
            {!refreshing ? (
              <RefreshCw aria-hidden="true" className="size-4" />
            ) : null}{' '}
            Обновить адаптеры
          </Button>
        </div>
      </section>

      <section className={box} aria-labelledby="scale-barcode-title">
        <div className="flex items-start gap-3">
          <Barcode
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          />
          <div className="space-y-1">
            <h2 id="scale-barcode-title" className="text-lg font-semibold">
              Штрихкод и печать
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Параметры весов должны совпадать с настройками организации в
              Maria.
            </p>
          </div>
        </div>
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <div className="space-y-3 rounded-lg bg-muted/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium">Префикс из Maria</p>
              <output
                aria-label="Префикс из Maria"
                className={`rounded-md px-3 py-1 text-sm font-semibold ${prefix ? 'bg-background text-foreground tabular-nums' : 'bg-warning-muted text-warning'}`}
              >
                {prefix ?? 'Не назначен'}
              </output>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Задаётся для организации в Maria. Здесь изменить его нельзя.
            </p>
          </div>
          <label className={field}>
            <span className="font-medium">Кодировка названий</span>
            <select
              aria-label="Кодировка названий"
              className={selectStyle}
              value={draft.nameEncoding}
              disabled={busy}
              onChange={(event) =>
                change({
                  nameEncoding: event.target
                    .value as ScaleDevice['nameEncoding'],
                  setupConfirmed: false,
                })
              }
            >
              <option value="windows-1251">Кириллица (Windows-1251)</option>
              <option value="ascii">Латиница (ASCII)</option>
            </select>
            <span className="text-xs leading-5 text-muted-foreground">
              Для русских названий выберите Windows-1251 и проверьте печать
              кириллицы.
            </span>
          </label>
        </div>
        {!prefix || !profileEnabled ? (
          <div className="flex items-start gap-3 rounded-lg border border-warning/25 bg-warning-muted/50 p-4">
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-warning"
            />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">
                {!prefix
                  ? 'Префикс весовых штрихкодов ещё не назначен.'
                  : 'Профиль весовых штрихкодов отключён.'}
              </p>
              <p className="text-sm leading-6 text-muted-foreground">
                Откройте Maria → Настройки → Организация → Весовые штрихкоды,
                сохраните префикс и включите профиль. Затем обновите каталог в
                приложении.
              </p>
            </div>
          </div>
        ) : null}
        {prefix && device && device.barcodePrefix !== prefix ? (
          <p className="rounded-lg border border-warning/25 bg-warning-muted/50 p-4 text-sm leading-6">
            Сохранённые настройки весов не совпадают с префиксом Maria.
            Проверьте Dept и пробную этикетку, затем подтвердите настройку
            повторно.
          </p>
        ) : null}
        <div className="space-y-3 border-t border-border pt-5">
          <h3 className="text-sm font-medium">Установите на весах</h3>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <dt className="text-xs text-muted-foreground">Тип штрихкода</dt>
              <dd className="text-sm font-semibold">07 · EAN-13</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-xs text-muted-foreground">Отдел (Dept)</dt>
              <dd className="text-sm font-semibold">
                {prefix ?? 'После назначения префикса'}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-xs text-muted-foreground">Формат цены</dt>
              <dd className="text-sm font-semibold">2 знака после запятой</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className={box} aria-labelledby="scale-label-title">
        <div className="flex items-start gap-3">
          <ClipboardCheck
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          />
          <div className="space-y-1">
            <h2 id="scale-label-title" className="text-lg font-semibold">
              Проверка этикетки
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Перед массовой загрузкой напечатайте пробную этикетку и проверьте
              название, цену и штрихкод в POS.
            </p>
          </div>
        </div>
        <p
          id="scale-label-format"
          className="rounded-lg bg-muted/60 px-4 py-3 text-sm leading-6 text-muted-foreground"
        >
          EAN-13: префикс + PLU (5 цифр) + вес в граммах (5 цифр) + контрольная
          цифра.
        </p>
        <label
          className={`flex items-start gap-3 rounded-lg border border-border p-4 text-sm leading-6 ${busy || !prefix || !profileEnabled ? 'text-muted-foreground' : 'cursor-pointer hover:bg-muted/40'}`}
        >
          <input
            className="mt-1 size-4 shrink-0 accent-primary"
            type="checkbox"
            aria-describedby="scale-label-format"
            checked={draft.setupConfirmed}
            disabled={busy || !prefix || !profileEnabled}
            onChange={(event) =>
              change({
                setupConfirmed: event.target.checked,
                barcodePrefix: prefix ?? '',
              })
            }
          />
          <span>
            <span className="block font-medium">Настройки весов проверены</span>
            <span className="block text-muted-foreground">
              Название и цена печатаются правильно, штрихкод распознаётся в POS.
            </span>
          </span>
        </label>
        <p className="text-xs leading-5 text-muted-foreground">
          Дизайн этикетки загружается через RLS. Неподдерживаемые символы в
          названиях не заменяются автоматически.
        </p>
      </section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs leading-5 text-muted-foreground">
          Настройки сохраняются на этом компьютере.
        </p>
        <Button disabled={busy} loading={saving} type="submit">
          Сохранить подключение
        </Button>
      </div>
    </form>
  );
}
