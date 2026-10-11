import {
  ArrowRight,
  Check,
  LoaderCircle,
  Package,
  Settings2,
} from 'lucide-react';

import { Button } from '@renderer/common/components/ui/button';

import type { CatalogState } from '../../../../shared/catalog';

export type WorkspaceHomeProps = {
  state: CatalogState;
  disabled?: boolean;
  onOpenDevice: () => void;
  onOpenCatalog: () => void;
};

type Summary = {
  label: string;
  detail: string;
  tone: 'neutral' | 'warning' | 'ready';
  loading?: boolean;
};

const checking: Summary = {
  label: 'Проверяем доступ',
  detail: 'Загружаем данные выбранного магазина.',
  tone: 'neutral',
  loading: true,
};

function deviceSummary(state: CatalogState): Summary {
  if (state.access === 'none') return checking;
  if (!state.device)
    return {
      label: 'Нет сохранённых настроек',
      detail:
        'Укажите адрес весов, выберите сетевой адаптер и проверьте параметры печати.',
      tone: 'neutral',
    };
  if (!state.profile)
    return {
      label: 'Профиль Maria ещё не получен',
      detail:
        'Обновите каталог, чтобы получить префикс и проверить настройки весов.',
      tone: 'neutral',
    };
  if (state.profile.blocked_reason)
    return {
      label: 'Конфликт штрихкодов',
      detail:
        'Исправьте конфликт в Maria и обновите каталог перед отправкой товаров.',
      tone: 'warning',
    };
  if (!state.profile?.prefix)
    return {
      label: 'Нужен префикс Maria',
      detail:
        'Назначьте префикс весовых штрихкодов в Maria и обновите каталог.',
      tone: 'warning',
    };
  if (!state.profile.enabled)
    return {
      label: 'Профиль Maria отключён',
      detail: 'Включите профиль весовых штрихкодов в Maria и обновите каталог.',
      tone: 'warning',
    };
  if (state.device.barcodePrefix !== state.profile.prefix)
    return {
      label: 'Префикс не совпадает',
      detail: 'Проверьте префикс на весах и подтвердите настройки повторно.',
      tone: 'warning',
    };
  if (!state.device.setupConfirmed)
    return {
      label: 'Нужна проверка этикетки',
      detail:
        'Настройки сохранены. Проверьте название, цену и штрихкод на пробной этикетке.',
      tone: 'warning',
    };
  return {
    label: 'Настройки подтверждены',
    detail: 'Связь с весами проверяется при отправке товаров.',
    tone: 'ready',
  };
}

function catalogSummary(state: CatalogState): Summary {
  if (state.access === 'none') return checking;
  const syncing =
    state.sync.running ?? ['pages', 'changes'].includes(state.sync.phase);
  if (syncing)
    return {
      label: state.sync.lastSyncedAt
        ? 'Обновляем каталог'
        : 'Загружаем каталог',
      detail: `Получено товаров: ${state.sync.loaded.toLocaleString('ru-RU')}. ${state.sync.lastSyncedAt ? 'Обновлённая' : 'Полная'} копия будет доступна после завершения обновления.`,
      tone: 'neutral',
      loading: true,
    };
  if (state.sync.phase === 'error')
    return {
      label: 'Ошибка обновления',
      detail:
        'Откройте каталог, чтобы проверить ошибку и повторить обновление.',
      tone: 'warning',
    };
  if (state.sync.phase === 'cancelled')
    return {
      label: 'Обновление остановлено',
      detail: 'Продолжить обновление можно в разделе каталога.',
      tone: 'warning',
    };
  if (state.sync.phase === 'pages' || state.sync.phase === 'changes')
    return {
      label: 'Ожидает продолжения',
      detail:
        'Обновление ещё не завершено. Откройте каталог, чтобы продолжить.',
      tone: 'warning',
    };
  if (!state.sync.lastSyncedAt)
    return {
      label: 'Каталог ещё не загружен',
      detail:
        'Первое полное обновление подготовит товары для работы на этом компьютере.',
      tone: 'neutral',
    };
  if (state.access === 'offline')
    return {
      label: 'Сохранённая копия',
      detail:
        'Можно просмотреть сохранённые товары и подготовить отправку на весы.',
      tone: 'neutral',
    };
  return state.total === 0
    ? {
        label: 'Каталог пуст',
        detail:
          'В сохранённом каталоге пока нет весовых товаров этого магазина.',
        tone: 'neutral',
      }
    : {
        label: 'Товары сохранены',
        detail:
          'Проверьте цены, выберите товары и подготовьте загрузку на весы.',
        tone: 'neutral',
      };
}

function Status({ summary }: { summary: Summary }) {
  const color =
    summary.tone === 'ready'
      ? 'bg-success-muted text-success'
      : summary.tone === 'warning'
        ? 'bg-warning-muted text-warning'
        : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ${color}`}
    >
      {summary.loading ? (
        <LoaderCircle
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin"
        />
      ) : null}
      {summary.tone === 'ready' ? (
        <Check aria-hidden="true" className="size-3.5 shrink-0" />
      ) : null}
      {summary.label}
    </span>
  );
}

export function WorkspaceHome({
  state,
  disabled = false,
  onOpenDevice,
  onOpenCatalog,
}: WorkspaceHomeProps) {
  const device = deviceSummary(state);
  const catalog = catalogSummary(state);
  const checkingAccess = state.access === 'none';
  const savedCatalog = !checkingAccess && state.sync.lastSyncedAt;
  const previousCopy =
    savedCatalog && (state.access === 'offline' || state.sync.phase !== 'idle');
  const card =
    'flex flex-col gap-6 rounded-2xl border border-border bg-card p-6 sm:p-7';
  const icon =
    'grid size-12 shrink-0 place-items-center rounded-xl bg-secondary text-secondary-foreground';

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <section className={card} aria-labelledby="workspace-catalog-title">
        <div className="flex items-start justify-between gap-4">
          <span className={icon}>
            <Package aria-hidden="true" className="size-6" />
          </span>
          <Status summary={catalog} />
        </div>
        <div className="space-y-2">
          <h2
            id="workspace-catalog-title"
            className="text-xl font-semibold tracking-tight"
          >
            Каталог товаров
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Весовые товары выбранного магазина и подготовка загрузки.
          </p>
        </div>
        <div className="flex-1 space-y-3">
          {savedCatalog ? (
            <div className="space-y-2">
              <p className="flex flex-wrap items-baseline gap-2">
                <span className="text-3xl font-semibold tracking-tight tabular-nums">
                  {state.total.toLocaleString('ru-RU')}
                </span>
                <span className="text-sm text-muted-foreground">
                  товаров сохранено
                </span>
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                Последнее обновление:{' '}
                <time dateTime={state.sync.lastSyncedAt!}>
                  {new Date(state.sync.lastSyncedAt!).toLocaleString('ru-RU', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </time>
              </p>
            </div>
          ) : null}
          <p className="text-sm leading-6 text-muted-foreground">
            {catalog.detail}
          </p>
          {previousCopy ? (
            <p className="text-xs leading-5 text-warning">
              Используется сохранённая копия. Цены могли измениться.
            </p>
          ) : null}
        </div>
        <Button
          className="w-full justify-between"
          disabled={disabled || checkingAccess}
          onClick={onOpenCatalog}
          type="button"
        >
          Открыть каталог <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
      </section>

      <section className={card} aria-labelledby="workspace-device-title">
        <div className="flex items-start justify-between gap-4">
          <span className={icon}>
            <Settings2 aria-hidden="true" className="size-6" />
          </span>
          <Status summary={device} />
        </div>
        <div className="space-y-2">
          <h2
            id="workspace-device-title"
            className="text-xl font-semibold tracking-tight"
          >
            Настройка весов
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Адрес устройства, сетевой адаптер и параметры этикетки.
          </p>
        </div>
        <div className="flex-1 space-y-3">
          {!checkingAccess && state.device ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Сохранённый адрес</p>
              <p className="break-all text-lg font-semibold tabular-nums">
                {state.device.scaleIp}:{state.device.port}
              </p>
            </div>
          ) : null}
          <p className="text-sm leading-6 text-muted-foreground">
            {device.detail}
          </p>
        </div>
        <Button
          className="w-full justify-between"
          disabled={disabled || checkingAccess}
          onClick={onOpenDevice}
          type="button"
        >
          Настроить весы <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
      </section>
    </div>
  );
}
