import { ArrowRight, Computer } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@renderer/common/components/ui/button';
import { Input } from '@renderer/common/components/ui/input';
import { Spinner } from '@renderer/common/components/ui/spinner';
import { useCatalogSession } from '@renderer/common/lib/catalog-session';

import {
  type CatalogPage,
  type CatalogState,
  type UploadPreview,
  emptyCatalogState,
} from '../../../../shared/catalog';
import type { NetworkAdapter } from '../../../../shared/diagnostics';
import { catalogErrorMessage } from './catalog-error';
import { ClearProducts } from './clear-products';
import { DeviceForm } from './device-form';
import {
  isDeviceOperationRunning,
  useDeviceOperationToasts,
} from './use-device-operation-toasts';
import { WorkspaceHeader, type WorkspaceSection } from './workspace-header';
import { WorkspaceHome } from './workspace-home';

type CatalogViewProps = {
  organizationName?: string;
  storeName: string;
  onChangeStore?: () => void;
  onChangeOrganization?: () => void;
  footer?: ReactNode;
  disabled?: boolean;
};

const dateLabel = (value: string | null): string =>
  value ? new Date(value).toLocaleString('ru-RU') : 'Ещё не завершена';
const errorLabel = catalogErrorMessage;
const box = 'space-y-4 rounded-xl border border-border bg-card p-5';

export function CatalogView({
  organizationName,
  storeName,
  onChangeStore,
  onChangeOrganization,
  footer,
  disabled = false,
}: CatalogViewProps) {
  useCatalogSession();
  const api = window.catalog;
  const [section, setSection] = useState<WorkspaceSection>('home');
  const [deviceOpened, setDeviceOpened] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const uploadRef = useRef<HTMLElement>(null);
  const focusUpload = useRef(false);
  const previousSection = useRef(section);
  const openDevice = (): void => {
    setDeviceOpened(true);
    setSection('device');
  };
  useEffect(() => {
    if (previousSection.current !== section) {
      const target = focusUpload.current ? uploadRef.current : null;
      (target ?? headingRef.current)?.focus();
      focusUpload.current = false;
    }
    previousSection.current = section;
  }, [section]);
  const [state, setState] = useState<CatalogState>(emptyCatalogState);
  useDeviceOperationToasts(state);
  const [page, setPage] = useState<CatalogPage>({ products: [], total: 0 });
  const [adapters, setAdapters] = useState<NetworkAdapter[]>([]);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<{
    result: UploadPreview;
    ids?: string[];
  } | null>(null);
  const [confirmUncertain, setConfirmUncertain] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const busy = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let current = true;
    let reading = false;
    const refresh = async (): Promise<void> => {
      if (reading) return;
      reading = true;
      try {
        const next = await api.request({ type: 'state' });
        if (current) setState(next);
      } catch (error) {
        if (current) setError(errorLabel(error));
      } finally {
        reading = false;
      }
    };
    void refresh();
    void api
      .request({ type: 'adapters' })
      .then((items) => {
        if (current) setAdapters(items);
      })
      .catch((error) => {
        if (current) setError(errorLabel(error));
      });
    const unsubscribe = api.onChange(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      current = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    if (!api || state.access === 'none' || section !== 'catalog') return;
    let current = true;
    void api
      .request({ type: 'list', search, offset })
      .then((result) => {
        if (current) setPage(result);
      })
      .catch((error) => {
        if (current) setError(errorLabel(error));
      });
    return () => {
      current = false;
    };
  }, [
    api,
    section,
    search,
    offset,
    state.access,
    state.scope?.storeId,
    state.sync.lastSyncedAt,
    state.sync.loaded,
    state.total,
    state.device?.nameEncoding,
    state.device?.barcodePrefix,
    state.device?.setupConfirmed,
  ]);

  const run = async (
    operation: () => Promise<void>,
    label = 'Выполняем действие…',
  ): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(label);
    setError(null);
    setNotice(null);
    const toastId = toast.loading(label);
    try {
      await operation();
      toast.dismiss(toastId);
    } catch (error) {
      const message = errorLabel(error);
      setError(message);
      toast.error('Не удалось выполнить действие', {
        id: toastId,
        description: message,
        duration: 10000,
      });
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };
  const notify = (message: string): void => {
    setNotice(message);
    toast.success(message);
  };
  const prepare = (ids?: string[]): void => {
    if (!api) return;
    setPrepared(null);
    setConfirmUncertain(false);
    void run(
      async () => {
        const result = await api.request({
          type: 'preview',
          ...(ids ? { productIds: ids } : {}),
        });
        setPrepared({ result, ids });
        if (result.blockers.length) {
          toast.warning('Загрузка пока недоступна', {
            description: result.blockers.join(' '),
            duration: 10000,
          });
        } else {
          toast.info('Товары проверены', {
            description: `Готово к загрузке: ${result.ready.length}. Проверьте список и подтвердите отправку.`,
          });
        }
      },
      ids ? 'Проверяем выбранные товары…' : 'Проверяем каталог…',
    );
  };
  const job = state.latestUpload;
  const uploading = isDeviceOperationRunning(job);
  const clearing = isDeviceOperationRunning(state.latestClear);
  const syncing =
    state.sync.running ??
    (state.sync.phase === 'pages' || state.sync.phase === 'changes');
  const locked = disabled || busy || uploading || clearing;
  const noAccess = state.access === 'none';
  const uncertain =
    job?.items.filter(
      (item) => item.state === 'uncertain' || item.state === 'in_flight',
    ).length ?? 0;
  const preview = prepared?.result;
  const previewStale =
    preview && preview.catalogSyncedAt !== state.sync.lastSyncedAt;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-8">
      <WorkspaceHeader
        section={section}
        organizationName={organizationName}
        storeName={storeName}
        locked={locked}
        headingRef={headingRef}
        onHome={() => setSection('home')}
        onChangeStore={onChangeStore}
        onChangeOrganization={onChangeOrganization}
      />
      {uploading || clearing ? (
        <div
          className="sticky top-28 z-20 space-y-3 rounded-xl border border-primary/20 bg-card p-4 shadow-md"
          role="status"
        >
          <div className="flex items-center gap-3">
            <Spinner className="size-5 text-primary" />
            <div>
              <p className="font-semibold">
                {pending ??
                  (clearing
                    ? 'Удаляем товары с весов…'
                    : 'Передаём товары в весы…')}
              </p>
              <p className="text-sm text-muted-foreground">
                {uploading
                  ? `Весы ${job!.device.scaleIp}. Подтверждено ${job!.items.filter((item) => item.state === 'acknowledged').length} из ${job!.items.length}.`
                  : `Весы ${state.latestClear!.device.scaleIp}. Ожидаем подтверждение очистки.`}
              </p>
            </div>
          </div>
          {uploading ? (
            <progress
              className="h-2 w-full accent-primary"
              aria-label="Загрузка товаров на весы"
              max={Math.max(job!.items.length, 1)}
              value={
                job!.items.filter((item) => item.state === 'acknowledged')
                  .length
              }
            />
          ) : null}
        </div>
      ) : null}
      {!api ? (
        <p className={box}>
          Локальная база и загрузка в весы доступны в установленном приложении
          Electron. Откройте приложение на компьютере.
        </p>
      ) : (
        <>
          {[error, state.error, state.sync.error]
            .filter(
              (value, index, list) => value && list.indexOf(value) === index,
            )
            .map((message) => (
              <p
                key={message}
                role="alert"
                className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive"
              >
                {message}
              </p>
            ))}
          {notice ? (
            <p role="status" className="text-sm">
              {notice}
            </p>
          ) : null}
          {state.access === 'offline' ? (
            <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
              Нет соединения с Maria. Доступны сохранённые товары; цены могли
              измениться. Доступ до {dateLabel(state.accessExpiresAt)}.
            </p>
          ) : null}
          {noAccess ? (
            <p role="status" className={box}>
              Проверяем доступ к локальному каталогу. Если проверка не
              завершится, войдите в Maria повторно.
            </p>
          ) : (
            <>
              {clearing && section !== 'device' ? (
                <section className={box} aria-label="Очистка весов выполняется">
                  <p className="font-semibold">
                    Удаляем товары с весов {state.latestClear!.device.scaleIp}…
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Остановка после отправки команды не отменяет удаление.
                  </p>
                  <Button variant="ghost" onClick={openDevice}>
                    Открыть очистку
                  </Button>
                </section>
              ) : null}
              {section !== 'catalog' && job ? (
                <section
                  className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5"
                  aria-label="Отправка на весы"
                >
                  <div className="space-y-1">
                    <h2 className="font-semibold">
                      {uploading
                        ? 'Передаём товары в весы'
                        : 'Последняя отправка на весы'}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {job.device.scaleIp} · Подтверждено{' '}
                      {
                        job.items.filter(
                          (item) => item.state === 'acknowledged',
                        ).length
                      }{' '}
                      из {job.items.length}
                    </p>
                    {!uploading && job.status !== 'completed' ? (
                      <p className="text-sm text-amber-700 dark:text-amber-400">
                        Отправка не завершена. Проверьте результат перед
                        повтором.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {uploading ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        loading={pending === 'Останавливаем загрузку…'}
                        onClick={() =>
                          void run(
                            async () =>
                              setState(
                                await api.request({ type: 'cancel-upload' }),
                              ),
                            'Останавливаем загрузку…',
                          )
                        }
                      >
                        Остановить загрузку
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      className="border-border text-foreground"
                      onClick={() => {
                        focusUpload.current = true;
                        setSection('catalog');
                      }}
                    >
                      {uploading ? 'Открыть отправку' : 'Посмотреть результат'}
                      <ArrowRight aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                </section>
              ) : null}
              {deviceOpened ? (
                <div hidden={section !== 'device'} className="space-y-4">
                  <DeviceForm
                    key={`${JSON.stringify(state.device)}-${state.profile?.prefix}`}
                    device={state.device}
                    prefix={state.profile?.prefix ?? null}
                    profileEnabled={state.profile?.enabled === true}
                    adapters={adapters}
                    busy={locked}
                    saving={pending === 'Сохраняем подключение…'}
                    refreshing={pending === 'Обновляем адаптеры…'}
                    onEdit={() => setPrepared(null)}
                    onRefreshAdapters={() =>
                      void run(
                        async () =>
                          setAdapters(await api.request({ type: 'adapters' })),
                        'Обновляем адаптеры…',
                      )
                    }
                    onSave={(device) => {
                      setPrepared(null);
                      void run(async () => {
                        setState(
                          await api.request({ type: 'save-device', device }),
                        );
                        notify('Настройки сохранены');
                      }, 'Сохраняем подключение…');
                    }}
                  />
                  {section === 'device' ? (
                    <ClearProducts
                      key={`${JSON.stringify(state.scope)}-${JSON.stringify(state.device)}`}
                      device={state.device}
                      job={state.latestClear}
                      api={api}
                      locked={locked}
                      pending={pending}
                      run={run}
                      onState={(next) => {
                        setPrepared(null);
                        setState(next);
                      }}
                      onNotice={notify}
                    />
                  ) : null}
                  <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                    <p>Товары и префикс штрихкода обновляются в каталоге.</p>
                    <Button
                      variant="ghost"
                      onClick={() => setSection('catalog')}
                    >
                      Открыть каталог{' '}
                      <ArrowRight aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                </div>
              ) : null}
              {section === 'catalog' ? (
                <div className="space-y-6">
                  <section
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-5 py-4"
                    aria-label="Весы для отправки"
                  >
                    <div className="flex items-center gap-3">
                      <Computer
                        aria-hidden="true"
                        className="size-5 text-muted-foreground"
                      />
                      <div className="text-sm">
                        <p className="font-medium">
                          {state.device
                            ? `Весы: ${state.device.scaleIp}`
                            : 'Весы ещё не настроены'}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Перед отправкой проверим товары и настройки.
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      className="h-10 px-3 text-sm"
                      onClick={openDevice}
                    >
                      Настроить весы
                    </Button>
                  </section>
                  <section className={box} aria-label="Синхронизация каталога">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <h2 className="font-semibold">
                          Товары из Maria: {state.total}
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Последняя полная синхронизация:{' '}
                          {dateLabel(state.sync.lastSyncedAt)}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          disabled={locked || syncing}
                          loading={syncing || pending === 'Обновляем каталог…'}
                          onClick={() =>
                            void run(
                              async () =>
                                setState(await api.request({ type: 'sync' })),
                              'Обновляем каталог…',
                            )
                          }
                        >
                          Обновить каталог
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy || !syncing}
                          loading={pending === 'Останавливаем синхронизацию…'}
                          onClick={() =>
                            void run(
                              async () =>
                                setState(
                                  await api.request({ type: 'cancel-sync' }),
                                ),
                              'Останавливаем синхронизацию…',
                            )
                          }
                        >
                          Остановить синхронизацию
                        </Button>
                      </div>
                    </div>
                    {syncing ? (
                      <p role="status" className="text-sm">
                        {state.sync.phase === 'pages'
                          ? 'Загружаем товары'
                          : 'Получаем изменения'}
                        : {state.sync.loaded}. Полная копия будет доступна после
                        завершения проверки изменений.
                      </p>
                    ) : null}
                    {state.sync.phase === 'cancelled' ? (
                      <p className="text-sm">
                        Синхронизация остановлена. Сохранённая полная копия
                        доступна.
                      </p>
                    ) : null}
                    {!syncing &&
                    (state.sync.phase === 'changes' ||
                      state.sync.phase === 'pages') ? (
                      <p role="status" className="text-sm">
                        Ожидаем продолжения синхронизации. Можно продолжить
                        сейчас кнопкой «Обновить каталог».
                      </p>
                    ) : null}
                    {state.sync.lastSyncedAt && state.sync.phase !== 'idle' ? (
                      <p className="text-sm text-amber-700 dark:text-amber-400">
                        Используется предыдущая полная копия. Цены могут быть
                        неактуальны до завершения синхронизации.
                      </p>
                    ) : null}
                  </section>
                  <section className={box} aria-label="Локальные товары">
                    <div className="flex flex-wrap items-center gap-3">
                      <Input
                        className="sm:max-w-sm"
                        aria-label="Поиск товаров"
                        placeholder="Название товара"
                        value={search}
                        onChange={(event) => {
                          setSearch(event.target.value);
                          setOffset(0);
                        }}
                      />
                      <span className="text-sm text-muted-foreground">
                        Найдено: {page.total} · Выбрано: {selected.length}
                      </span>
                      {selected.length ? (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setSelected([]);
                            setPrepared(null);
                          }}
                        >
                          Сбросить выбор
                        </Button>
                      ) : null}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-border text-muted-foreground">
                            <th className="p-3">
                              <span className="sr-only">Выбор</span>
                            </th>
                            <th className="p-3">Товар</th>
                            <th className="p-3">PLU</th>
                            <th className="p-3">Цена за кг</th>
                            <th className="p-3">Состояние</th>
                          </tr>
                        </thead>
                        <tbody>
                          {page.products.map((product) => (
                            <tr
                              key={product.id}
                              className="border-b border-border last:border-0"
                            >
                              <td className="p-3">
                                <input
                                  type="checkbox"
                                  aria-label={`Выбрать ${product.name}`}
                                  checked={selected.includes(product.id)}
                                  disabled={locked}
                                  onChange={(event) => {
                                    setSelected((ids) =>
                                      event.target.checked
                                        ? [...ids, product.id]
                                        : ids.filter((id) => id !== product.id),
                                    );
                                    setPrepared(null);
                                  }}
                                />
                              </td>
                              <td className="p-3">
                                <p className="font-medium">{product.name}</p>
                                {product.scale_name ? (
                                  <p className="text-xs text-muted-foreground">
                                    На этикетке: {product.scale_name}
                                  </p>
                                ) : null}
                              </td>
                              <td className="p-3">
                                {product.scale_plu ?? 'Не назначен'}
                              </td>
                              <td className="p-3 tabular-nums">
                                {product.retail_price ?? 'Нет цены'}
                              </td>
                              <td className="p-3">
                                {product.issues.length ? (
                                  <span className="text-amber-700 dark:text-amber-400">
                                    {product.issues.join('; ')}
                                  </span>
                                ) : product.is_active ? (
                                  'Готов'
                                ) : (
                                  'Неактивен'
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {page.products.length === 0 ? (
                      <p className="py-4 text-center text-sm text-muted-foreground">
                        {state.sync.lastSyncedAt
                          ? 'Товары не найдены'
                          : 'Ожидаем первую полную загрузку каталога'}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          disabled={offset === 0}
                          onClick={() => setOffset(Math.max(0, offset - 100))}
                        >
                          Назад
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {page.total
                            ? `${offset + 1}–${Math.min(offset + 100, page.total)} из ${page.total}`
                            : '0 товаров'}
                        </span>
                        <Button
                          variant="ghost"
                          disabled={offset + 100 >= page.total}
                          onClick={() => setOffset(offset + 100)}
                        >
                          Далее
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="ghost"
                          disabled={locked || !state.sync.lastSyncedAt}
                          loading={pending === 'Проверяем каталог…'}
                          onClick={() => prepare()}
                        >
                          Подготовить весь каталог
                        </Button>
                        <Button
                          loading={pending === 'Проверяем выбранные товары…'}
                          disabled={
                            locked ||
                            !selected.length ||
                            !state.sync.lastSyncedAt
                          }
                          onClick={() => prepare([...selected])}
                        >
                          Подготовить выбранные ({selected.length})
                        </Button>
                      </div>
                    </div>
                  </section>
                  {preview ? (
                    <section className={box} aria-label="Подготовка загрузки">
                      <h2 className="text-lg font-semibold">
                        Проверка перед загрузкой
                      </h2>
                      <p>Готово к загрузке: {preview.ready.length}</p>
                      <p className="text-sm text-muted-foreground">
                        Эти товары будут записаны по их PLU. Существующие записи
                        с теми же PLU будут обновлены. Дизайн этикетки
                        сохраняется.
                      </p>
                      {preview.blockers.map((blocker) => (
                        <p key={blocker} className="text-sm text-destructive">
                          {blocker}
                        </p>
                      ))}
                      {preview.excluded.length ? (
                        <details>
                          <summary className="cursor-pointer text-sm">
                            Не будут загружены: {preview.excluded.length}
                          </summary>
                          <ul className="mt-3 max-h-56 space-y-2 overflow-auto text-sm">
                            {preview.excluded.map((item) => (
                              <li key={item.id}>
                                {item.name}: {item.issues.join('; ')}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      {preview.removalRequired.length ? (
                        <div className="space-y-2 text-sm text-amber-700 dark:text-amber-400">
                          <p>
                            На весах могут остаться устаревшие товары. Удалите
                            отдельные PLU через RLS или очистите все товары в
                            настройках весов перед новой загрузкой.
                          </p>
                          <ul>
                            {preview.removalRequired.map((item) => (
                              <li key={item.id}>
                                {item.name} — PLU {item.plu}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {previewStale ? (
                        <p className="text-sm text-amber-700">
                          Каталог обновился. Подготовьте загрузку повторно.
                        </p>
                      ) : null}
                      {preview.uncertainCount > 0 ? (
                        <label className="flex items-start gap-3 text-sm">
                          <input
                            className="mt-1"
                            type="checkbox"
                            checked={confirmUncertain}
                            onChange={(event) =>
                              setConfirmUncertain(event.target.checked)
                            }
                          />
                          <span>
                            Проверил весы после неподтверждённой отправки и
                            разрешаю повторную запись товаров.
                          </span>
                        </label>
                      ) : null}
                      <Button
                        loading={pending === 'Запускаем загрузку…'}
                        disabled={
                          locked ||
                          !preview.ready.length ||
                          preview.blockers.length > 0 ||
                          Boolean(previewStale) ||
                          (preview.uncertainCount > 0 && !confirmUncertain)
                        }
                        onClick={() =>
                          void run(async () => {
                            setState(
                              await api.request({
                                type: 'upload',
                                revision: preview.revision,
                                ...(prepared?.ids
                                  ? { productIds: prepared.ids }
                                  : {}),
                                confirmUncertain,
                              }),
                            );
                            setPrepared(null);
                          }, 'Запускаем загрузку…')
                        }
                      >
                        Загрузить {preview.ready.length}{' '}
                        {preview.ready.length === 1 ? 'товар' : 'товаров'} на
                        весы
                      </Button>
                    </section>
                  ) : null}
                  {job ? (
                    <section
                      ref={uploadRef}
                      tabIndex={-1}
                      className={`${box} outline-none`}
                      aria-label="Результат загрузки"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="text-lg font-semibold">
                          {uploading
                            ? 'Передаём товары в весы'
                            : 'Последняя загрузка'}
                        </h2>
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            disabled={!uploading || busy}
                            loading={pending === 'Останавливаем загрузку…'}
                            onClick={() =>
                              void run(
                                async () =>
                                  setState(
                                    await api.request({
                                      type: 'cancel-upload',
                                    }),
                                  ),
                                'Останавливаем загрузку…',
                              )
                            }
                          >
                            Остановить загрузку
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            loading={pending === 'Сохраняем отчёт…'}
                            onClick={() =>
                              void run(async () => {
                                const path = await api.request({
                                  type: 'export-upload',
                                });
                                if (path) notify(`Отчёт сохранён: ${path}`);
                              }, 'Сохраняем отчёт…')
                            }
                          >
                            Сохранить отчёт
                          </Button>
                        </div>
                      </div>
                      <p className="text-sm">
                        Подтверждено весами:{' '}
                        {
                          job.items.filter(
                            (item) => item.state === 'acknowledged',
                          ).length
                        }{' '}
                        из {job.items.length}. Отклонено:{' '}
                        {
                          job.items.filter((item) => item.state === 'rejected')
                            .length
                        }
                        . Ожидает отправки:{' '}
                        {
                          job.items.filter((item) => item.state === 'pending')
                            .length
                        }
                        .
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {job.status === 'completed'
                          ? 'Передача завершена'
                          : job.status === 'cancelled'
                            ? 'Передача остановлена'
                            : job.status === 'interrupted'
                              ? 'Передача прервана при закрытии приложения'
                              : job.status === 'failed'
                                ? 'Ошибка передачи'
                                : 'Передача выполняется'}
                        . {dateLabel(job.createdAt)}
                      </p>
                      {uncertain > 0 ? (
                        <p className="text-sm text-amber-700 dark:text-amber-400">
                          Нет подтверждения для {uncertain} товаров. Они могли
                          сохраниться на весах. Проверьте их перед повторной
                          отправкой.
                        </p>
                      ) : null}
                      {job.error ? (
                        <p className="text-sm text-destructive">{job.error}</p>
                      ) : null}
                      {job.disconnectError ? (
                        <p className="text-sm text-destructive">
                          Завершение связи: {job.disconnectError}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        Подтверждение записи не проверяет внешний вид этикетки.
                        Напечатайте пробную этикетку и проверьте её в POS.
                      </p>
                    </section>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </>
      )}
      {section === 'home' ? (
        <WorkspaceHome
          state={state}
          disabled={!api || noAccess || disabled}
          onOpenDevice={openDevice}
          onOpenCatalog={() => setSection('catalog')}
        />
      ) : null}
      {footer}
    </main>
  );
}
