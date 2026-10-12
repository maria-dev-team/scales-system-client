import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CatalogApi,
  type CatalogProduct,
  type CatalogRequest,
  type CatalogState,
  type UploadPreview,
  emptyCatalogState,
} from '../../../../shared/catalog';
import { CatalogView } from './catalog-view';

const product: CatalogProduct = {
  id: 'apple',
  organization_id: 'org',
  store_id: 'store',
  name: 'Яблоки',
  scale_name: null,
  scale_plu: 15,
  barcode: '123',
  unit: 'kg',
  retail_price: '120.50',
  is_active: true,
  updated_at: '2026-10-11T10:00:00Z',
};
let state: CatalogState;
let preview: UploadPreview;
let saveError: Error | null;
let syncRequest: () => Promise<CatalogState>;
const listeners = new Set<() => void>();
const request = vi.fn(async (input: CatalogRequest): Promise<unknown> => {
  if (input.type === 'state') return state;
  if (input.type === 'sync') return syncRequest();
  if (input.type === 'list')
    return { products: [{ ...product, issues: [] }], total: 1 };
  if (input.type === 'adapters')
    return [
      {
        name: 'Ethernet',
        address: '192.168.1.2',
        netmask: '255.255.255.0',
        mac: '',
      },
    ];
  if (input.type === 'preview') return preview;
  if (input.type === 'prepare-clear')
    return {
      token: 'clear-token',
      device: state.device,
      expiresAt: '2099-01-01T00:00:00Z',
    };
  if (input.type === 'save-device') {
    if (saveError) throw saveError;
    state = { ...state, device: input.device };
  }
  return state;
});

beforeEach(() => {
  listeners.clear();
  syncRequest = async () => state;
  request.mockClear();
  saveError = null;
  state = {
    ...emptyCatalogState(),
    access: 'online',
    total: 1,
    scope: {
      apiUrl: 'https://api.example.test',
      userId: 'user',
      membershipId: 'member',
      organizationId: 'org',
      storeId: 'store',
      storeName: 'Центральный',
    },
    sync: {
      phase: 'idle',
      loaded: 1,
      lastSyncedAt: '2026-10-11T10:00:00Z',
      error: null,
    },
    profile: {
      format: 'ean13-weight-v1',
      prefix: '21',
      enabled: true,
      blocked_reason: null,
    },
    device: {
      scaleIp: '192.168.1.8',
      localAddress: '192.168.1.2',
      port: 5001,
      nameEncoding: 'windows-1251',
      barcodePrefix: '21',
      setupConfirmed: true,
    },
  };
  preview = {
    revision: 'preview1',
    uncertainCount: 0,
    ready: [product],
    excluded: [],
    removalRequired: [],
    blockers: [],
    catalogSyncedAt: state.sync.lastSyncedAt,
  };
  Object.defineProperty(window, 'catalog', {
    configurable: true,
    value: {
      request: request as CatalogApi['request'],
      onChange: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onRefreshRequired: () => () => {},
    },
  });
});
afterEach(() =>
  Object.defineProperty(window, 'catalog', {
    configurable: true,
    value: undefined,
  }),
);
const mount = () =>
  render(<CatalogView organizationName="Мария" storeName="Центральный" />);

const openCatalog = async () => {
  await userEvent.click(
    await screen.findByRole('button', { name: 'Открыть каталог' }),
  );
};
const openDevice = async () => {
  await userEvent.click(
    await screen.findByRole('button', { name: 'Настроить весы' }),
  );
};

describe('weighted catalog', () => {
  it('shows clearing only in device settings and drops its confirmation after navigation', async () => {
    mount();
    expect(
      screen.queryByRole('button', { name: 'Удалить все товары с весов' }),
    ).not.toBeInTheDocument();
    await openDevice();
    await userEvent.click(
      screen.getByRole('button', { name: 'Удалить все товары с весов' }),
    );
    expect(
      await screen.findByRole('button', {
        name: 'Подтвердить удаление всех товаров',
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'На главную' }));
    await openDevice();
    expect(
      screen.queryByRole('button', {
        name: 'Подтвердить удаление всех товаров',
      }),
    ).not.toBeInTheDocument();
    expect(
      request.mock.calls.some(([input]) => input.type === 'clear-products'),
    ).toBe(false);
  });

  it('keeps uploads and device changes locked while a clear job is running', async () => {
    state.latestClear = {
      id: 'clear-job',
      scope: state.scope!,
      device: state.device!,
      createdAt: '2026-10-11T10:00:00Z',
      finishedAt: null,
      status: 'running',
      commandState: 'in_flight',
      events: [],
      error: null,
      disconnectError: null,
    };
    mount();
    await screen.findByRole('button', { name: 'Открыть очистку' });
    await openCatalog();
    expect(
      screen.getByRole('button', { name: 'Подготовить весь каталог' }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Открыть очистку' }),
    );
    expect(
      screen.getByRole('button', { name: 'Сохранить подключение' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Удалить все товары с весов' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Остановить очистку' }),
    ).toBeEnabled();
  });
  it('starts on the workspace without reading product rows or starting an upload', async () => {
    mount();
    expect(
      await screen.findByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    expect(
      await screen.findByRole('button', { name: 'Настроить весы' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Открыть каталог' }),
    ).toBeEnabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: 'IP весов' }),
    ).not.toBeInTheDocument();
    expect(
      request.mock.calls.some(([input]) =>
        ['list', 'preview', 'upload'].includes(input.type),
      ),
    ).toBe(false);
  });

  it('preserves an unsaved device draft when returning home and reopening settings', async () => {
    const browser = userEvent.setup();
    mount();
    await openDevice();
    const ip = await screen.findByRole('textbox', { name: 'IP весов' });
    await browser.clear(ip);
    await browser.type(ip, '192.168.1.87');
    await browser.selectOptions(
      screen.getByLabelText('Кодировка названий'),
      'ascii',
    );
    await browser.click(screen.getByRole('button', { name: 'На главную' }));
    expect(
      screen.getByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('textbox', { name: 'IP весов' }),
    ).not.toBeInTheDocument();
    await openDevice();
    expect(screen.getByRole('textbox', { name: 'IP весов' })).toHaveValue(
      '192.168.1.87',
    );
    expect(screen.getByLabelText('Кодировка названий')).toHaveValue('ascii');
    expect(
      screen.getByRole('checkbox', { name: /Настройки весов проверены/ }),
    ).not.toBeChecked();
    expect(
      request.mock.calls.some(([input]) =>
        ['save-device', 'list', 'upload'].includes(input.type),
      ),
    ).toBe(false);
  });

  it('preserves catalog search and selection through home navigation', async () => {
    const browser = userEvent.setup();
    mount();
    await openCatalog();
    await browser.type(screen.getByLabelText('Поиск товаров'), 'Яблоки');
    await browser.click(
      await screen.findByRole('checkbox', { name: 'Выбрать Яблоки' }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: 'list',
        search: 'Яблоки',
        offset: 0,
      }),
    );
    await browser.click(screen.getByRole('button', { name: 'На главную' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await openCatalog();
    expect(screen.getByLabelText('Поиск товаров')).toHaveValue('Яблоки');
    expect(
      screen.getByRole('checkbox', { name: 'Выбрать Яблоки' }),
    ).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Подготовить выбранные (1)' }),
    ).toBeEnabled();
    expect(request.mock.calls.some(([input]) => input.type === 'upload')).toBe(
      false,
    );
  });

  it('allows navigation during upload while preventing a store or organization change', async () => {
    state.latestUpload = {
      id: 'running',
      scope: state.scope!,
      device: state.device!,
      catalogSyncedAt: state.sync.lastSyncedAt!,
      createdAt: '2026-10-11T10:00:00Z',
      finishedAt: null,
      status: 'running',
      items: [{ product, packetHex: '00', state: 'in_flight', error: null }],
      events: [],
      error: null,
      disconnectError: null,
    };
    const changeStore = vi.fn();
    const changeOrganization = vi.fn();
    const browser = userEvent.setup();
    render(
      <CatalogView
        organizationName="Мария"
        storeName="Центральный"
        onChangeStore={changeStore}
        onChangeOrganization={changeOrganization}
      />,
    );
    const openUpload = await screen.findByRole('button', {
      name: 'Открыть отправку',
    });
    expect(
      screen.getByRole('button', { name: 'Сменить магазин' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Сменить организацию' }),
    ).toBeDisabled();
    await browser.click(openUpload);
    expect(
      screen.getByRole('region', { name: 'Результат загрузки' }),
    ).toHaveFocus();
    expect(
      screen.queryByRole('button', { name: 'Сменить магазин' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Сменить организацию' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Остановить загрузку' }),
    ).toBeEnabled();
    await browser.click(screen.getByRole('button', { name: 'На главную' }));
    expect(
      screen.getByRole('button', { name: 'Сменить магазин' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Сменить организацию' }),
    ).toBeDisabled();
    await openDevice();
    expect(screen.getByRole('textbox', { name: 'IP весов' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Сменить магазин' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Сменить организацию' }),
    ).not.toBeInTheDocument();
    expect(changeStore).not.toHaveBeenCalled();
    expect(changeOrganization).not.toHaveBeenCalled();
    expect(
      request.mock.calls.some(([input]) =>
        ['upload', 'cancel-upload'].includes(input.type),
      ),
    ).toBe(false);
  });

  it('reads local products without starting synchronization or hardware upload from rendering', async () => {
    mount();
    await openCatalog();
    expect(await screen.findByText('Яблоки')).toBeVisible();
    expect(screen.getByText('120.50')).toBeVisible();
    expect(
      request.mock.calls.some(([input]) =>
        ['connect', 'sync', 'upload'].includes(input.type),
      ),
    ).toBe(false);
  });

  it('previews the selected products and uploads only after the explicit confirmation', async () => {
    const browser = userEvent.setup();
    mount();
    await openCatalog();
    await browser.click(
      await screen.findByRole('checkbox', { name: 'Выбрать Яблоки' }),
    );
    await browser.click(
      screen.getByRole('button', { name: 'Подготовить выбранные (1)' }),
    );
    expect(await screen.findByText('Готово к загрузке: 1')).toBeVisible();
    expect(request).toHaveBeenCalledWith({
      type: 'preview',
      productIds: ['apple'],
    });
    expect(request.mock.calls.some(([input]) => input.type === 'upload')).toBe(
      false,
    );
    await browser.click(
      screen.getByRole('button', { name: 'Загрузить 1 товар на весы' }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: 'upload',
        revision: 'preview1',
        productIds: ['apple'],
        confirmUncertain: false,
      }),
    );
  });

  it('shows blockers and required removals instead of enabling upload', async () => {
    preview = {
      ...preview,
      blockers: ['Профиль весового штрихкода отключён'],
      removalRequired: [{ id: 'old', name: 'Старый товар', plu: 9 }],
    };
    const browser = userEvent.setup();
    mount();
    await openCatalog();
    await browser.click(
      await screen.findByRole('button', { name: 'Подготовить весь каталог' }),
    );
    expect(
      await screen.findByText('Профиль весового штрихкода отключён'),
    ).toBeVisible();
    expect(screen.getByText(/Старый товар.*9/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Загрузить 1 товар на весы' }),
    ).toBeDisabled();
  });

  it('reports device saving errors and does not silently enable setup confirmation', async () => {
    state = { ...state, device: null };
    saveError = new Error('Неверный IP весов');
    const browser = userEvent.setup();
    mount();
    await openDevice();
    const ip = await screen.findByRole('textbox', { name: 'IP весов' });
    await browser.type(ip, 'wrong-ip');
    await browser.selectOptions(
      screen.getByLabelText('Ethernet-адаптер'),
      '192.168.1.2',
    );
    expect(
      screen.getByRole('checkbox', { name: /Настройки весов проверены/ }),
    ).not.toBeChecked();
    await browser.click(
      screen.getByRole('button', { name: 'Сохранить подключение' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Неверный IP весов',
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'save-device',
        device: expect.objectContaining({ setupConfirmed: false }),
      }),
    );
  });

  it('requires an explicit retry confirmation after an uncertain upload', async () => {
    preview.uncertainCount = 1;
    state.latestUpload = {
      id: 'previous',
      scope: state.scope!,
      device: state.device!,
      catalogSyncedAt: state.sync.lastSyncedAt!,
      createdAt: '2026-10-11T10:00:00Z',
      finishedAt: '2026-10-11T10:00:01Z',
      status: 'failed',
      items: [
        { product, packetHex: '00', state: 'uncertain', error: 'Таймаут' },
      ],
      events: [],
      error: 'Ответ весов не получен',
      disconnectError: null,
    };
    const browser = userEvent.setup();
    mount();
    await openCatalog();
    await browser.click(
      await screen.findByRole('button', { name: 'Подготовить весь каталог' }),
    );
    const upload = await screen.findByRole('button', {
      name: 'Загрузить 1 товар на весы',
    });
    expect(upload).toBeDisabled();
    await browser.click(
      screen.getByRole('checkbox', {
        name: /Проверил весы после неподтверждённой отправки/,
      }),
    );
    await browser.click(upload);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: 'upload',
        revision: 'preview1',
        confirmUncertain: true,
      }),
    );
  });

  it('shows saved products offline and keeps manual preparation available', async () => {
    state = {
      ...state,
      access: 'offline',
      accessExpiresAt: '2026-10-11T18:00:00Z',
    };
    mount();
    await openCatalog();
    expect(await screen.findByText('Яблоки')).toBeVisible();
    expect(screen.getByText(/Нет соединения с Maria/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Обновить каталог' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Подготовить весь каталог' }),
    ).toBeEnabled();
    expect(
      request.mock.calls.some(([input]) =>
        ['connect', 'sync', 'upload'].includes(input.type),
      ),
    ).toBe(false);
  });

  it('derives the device prefix from Maria and requires checking the scale again after a mismatch', async () => {
    state.device = {
      ...state.device!,
      barcodePrefix: '20',
      setupConfirmed: true,
    };
    const browser = userEvent.setup();
    mount();
    await openDevice();
    const prefix = await screen.findByRole('status', {
      name: 'Префикс из Maria',
    });
    expect(prefix).toHaveTextContent('21');
    expect(
      screen.queryByRole('textbox', { name: 'Префикс из Maria' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /Настройки весов проверены/ }),
    ).not.toBeChecked();
    await browser.click(
      screen.getByRole('button', { name: 'Сохранить подключение' }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'save-device',
          device: expect.objectContaining({
            barcodePrefix: '21',
            setupConfirmed: false,
          }),
        }),
      ),
    );
  });

  it.each([null, '21'])(
    'directs setup to Maria when the profile is disabled with prefix %s',
    async (prefix) => {
      state.profile = {
        format: 'ean13-weight-v1',
        enabled: false,
        blocked_reason: null,
        prefix,
      };
      state.device = null;
      mount();
      await openDevice();
      expect(
        await screen.findByText(/Maria → Настройки → Организация/),
      ).toBeVisible();
      expect(
        screen.getByRole('status', { name: 'Префикс из Maria' }),
      ).toHaveTextContent(prefix ?? 'Не назначен');
      expect(
        screen.queryByRole('textbox', { name: 'Префикс из Maria' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('checkbox', { name: /Настройки весов проверены/ }),
      ).toBeDisabled();
    },
  );

  it('allows continuing an incomplete sync without describing old prices as current', async () => {
    state.sync = { ...state.sync, phase: 'changes', running: false };
    mount();
    await openCatalog();
    expect(
      await screen.findByText(/Ожидаем продолжения синхронизации/),
    ).toBeVisible();
    expect(screen.getByText(/Цены могут быть неактуальны/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Обновить каталог' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Остановить синхронизацию' }),
    ).toBeDisabled();
  });

  it('requires checking older uncertain items even when the latest upload completed', async () => {
    preview.uncertainCount = 1;
    const browser = userEvent.setup();
    mount();
    await openCatalog();
    await browser.click(
      await screen.findByRole('button', { name: 'Подготовить весь каталог' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Загрузить 1 товар на весы' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', {
        name: /Проверил весы после неподтверждённой отправки/,
      }),
    ).toBeVisible();
  });
});

const emitState = async () =>
  act(async () => {
    listeners.forEach((listener) => listener());
  });

describe('manual catalog refresh feedback', () => {
  beforeEach(() => {
    vi.spyOn(toast, 'loading').mockReturnValue('catalog-refresh');
    vi.spyOn(toast, 'success').mockReturnValue('catalog-refresh');
    vi.spyOn(toast, 'error').mockReturnValue('catalog-refresh');
    vi.spyOn(toast, 'warning').mockReturnValue('catalog-refresh');
    vi.spyOn(toast, 'dismiss').mockReturnValue('catalog-refresh');
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps progress after the start ACK, prevents repeat clicks and confirms the actual finish once', async () => {
    syncRequest = async () =>
      (state = {
        ...state,
        sync: { ...state.sync, running: true, phase: 'changes' },
      });
    mount();
    await openCatalog();
    const button = screen.getByRole('button', { name: 'Обновить каталог' });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(toast.dismiss).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(
      request.mock.calls.filter(([input]) => input.type === 'sync'),
    ).toHaveLength(1);
    // A state read started before the click may arrive after the start ACK.
    state = {
      ...state,
      sync: { ...state.sync, running: false, phase: 'idle' },
    };
    await emitState();
    expect(button).toBeDisabled();
    expect(toast.warning).not.toHaveBeenCalled();
    state = {
      ...state,
      sync: {
        ...state.sync,
        running: false,
        phase: 'idle',
        lastSyncedAt: '2026-10-12T15:00:00Z',
      },
    };
    await emitState();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Каталог актуален',
        expect.objectContaining({ id: 'catalog-refresh', duration: 6000 }),
      ),
    );
    expect(
      within(
        screen.getByRole('region', { name: 'Синхронизация каталога' }),
      ).getByText('Каталог актуален'),
    ).toBeVisible();
    expect(button).toBeEnabled();
    await emitState();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('confirms a fast refresh with unchanged product count even when no running state was observed', async () => {
    syncRequest = async () =>
      (state = {
        ...state,
        sync: {
          ...state.sync,
          running: false,
          phase: 'idle',
          lastSyncedAt: '2026-10-12T15:00:00Z',
        },
      });
    mount();
    await openCatalog();
    await userEvent.click(
      screen.getByRole('button', { name: 'Обновить каталог' }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Каталог актуален',
        expect.objectContaining({
          duration: 6000,
          description: expect.stringContaining('1'),
        }),
      ),
    );
    expect(screen.getByText('Каталог актуален')).toBeVisible();
  });

  it.each(['error', 'cancelled', 'changes', 'offline'] as const)(
    'does not report an old snapshot as current after %s',
    async (outcome) => {
      syncRequest = async () =>
        (state = {
          ...state,
          access: outcome === 'offline' ? 'offline' : 'online',
          sync: {
            ...state.sync,
            running: false,
            phase: outcome === 'offline' ? 'idle' : outcome,
            error: outcome === 'error' ? 'Сервер недоступен' : null,
          },
        });
      mount();
      await openCatalog();
      await userEvent.click(
        screen.getByRole('button', { name: 'Обновить каталог' }),
      );
      await waitFor(() =>
        expect(
          outcome === 'error' ? toast.error : toast.warning,
        ).toHaveBeenCalled(),
      );
      expect(toast.success).not.toHaveBeenCalled();
      expect(screen.queryByText('Каталог актуален')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Обновить каталог' }),
      ).toBeEnabled();
    },
  );

  it('reports a rejected refresh command and leaves retry available', async () => {
    syncRequest = async () => {
      throw new Error('Нет соединения');
    };
    mount();
    await openCatalog();
    await userEvent.click(
      screen.getByRole('button', { name: 'Обновить каталог' }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Обновить каталог' }),
    ).toBeEnabled();
  });

  it('dismisses pending feedback on unmount and ignores a late successful response', async () => {
    let finish!: (next: CatalogState) => void;
    syncRequest = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const mounted = mount();
    await openCatalog();
    await userEvent.click(
      screen.getByRole('button', { name: 'Обновить каталог' }),
    );
    mounted.unmount();
    expect(toast.dismiss).toHaveBeenCalledWith('catalog-refresh');
    await act(async () =>
      finish({
        ...state,
        sync: { ...state.sync, lastSyncedAt: '2026-10-12T15:00:00Z' },
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
