import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { toast } from 'sonner';
import { beforeEach, expect, it, vi } from 'vitest';

import {
  type CatalogState,
  type ClearPluJob,
  type UploadJob,
  emptyCatalogState,
} from '../../../../shared/catalog';
import {
  isDeviceOperationRunning,
  useDeviceOperationToasts,
} from './use-device-operation-toasts';

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const scope = {
  apiUrl: 'https://api.test',
  userId: 'user',
  membershipId: 'member',
  organizationId: 'org',
  storeId: 'store',
  storeName: 'Магазин',
};
const device = {
  scaleIp: '192.168.1.8',
  localAddress: '192.168.1.2',
  port: 5001,
  nameEncoding: 'ascii' as const,
  barcodePrefix: '20',
  setupConfirmed: true,
};
function upload(overrides: Partial<UploadJob> = {}): UploadJob {
  return {
    id: 'upload-1',
    scope,
    device,
    createdAt: '2026-10-11T10:00:00Z',
    catalogSyncedAt: '2026-10-11T09:00:00Z',
    finishedAt: null,
    status: 'running',
    error: null,
    disconnectError: null,
    events: [],
    items: [
      {
        product: {
          id: 'apple',
          organization_id: 'org',
          store_id: 'store',
          name: 'Apple',
          scale_name: null,
          scale_plu: 1,
          barcode: '',
          unit: 'kg',
          retail_price: '100',
          is_active: true,
          updated_at: '2026-10-11T09:00:00Z',
        },
        packetHex: '',
        state: 'pending',
        error: null,
      },
    ],
    ...overrides,
  };
}
function clear(overrides: Partial<ClearPluJob> = {}): ClearPluJob {
  return {
    id: 'clear-1',
    scope,
    device,
    createdAt: '2026-10-11T10:00:00Z',
    finishedAt: null,
    status: 'running',
    commandState: 'pending',
    error: null,
    disconnectError: null,
    events: [],
    ...overrides,
  };
}
const finishedAt = '2026-10-11T10:01:00Z';
const state = (overrides: Partial<CatalogState> = {}): CatalogState => ({
  ...emptyCatalogState(),
  scope,
  access: 'online',
  ...overrides,
});
beforeEach(() => vi.clearAllMocks());

it('leaves historical terminal jobs silent after mount and initial asynchronous state loading', () => {
  const { rerender } = renderHook(useDeviceOperationToasts, {
    initialProps: emptyCatalogState(),
  });
  rerender(
    state({
      latestUpload: upload({
        status: 'failed',
        finishedAt,
        error: 'Old error',
      }),
      latestClear: clear({
        status: 'completed',
        finishedAt,
        commandState: 'acknowledged',
      }),
    }),
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.loading).not.toHaveBeenCalled();
});

it('shows a running job on mount, updates progress once and replaces it with success', () => {
  const running = upload();
  const { rerender } = renderHook(useDeviceOperationToasts, {
    initialProps: state({ latestUpload: running }),
  });
  expect(toast.loading).toHaveBeenCalledWith(
    'Загружаем товары на весы…',
    expect.objectContaining({
      id: 'catalog-upload-upload-1',
      duration: Infinity,
      description: expect.stringContaining(
        '192.168.1.8:5001 · Подтверждено товаров: 0/1',
      ),
    }),
  );
  rerender(state({ latestUpload: structuredClone(running) }));
  expect(toast.loading).toHaveBeenCalledTimes(1);
  const acknowledged = upload({
    items: [{ ...running.items[0]!, state: 'acknowledged' }],
  });
  rerender(state({ latestUpload: acknowledged }));
  expect(toast.loading).toHaveBeenCalledTimes(2);
  const completed = {
    ...acknowledged,
    status: 'completed' as const,
    finishedAt,
  };
  rerender(state({ latestUpload: completed }));
  rerender(state({ latestUpload: structuredClone(completed) }));
  expect(toast.success).toHaveBeenCalledOnce();
  expect(toast.success).toHaveBeenCalledWith(
    'Загрузка завершена',
    expect.objectContaining({
      id: 'catalog-upload-upload-1',
      duration: 6000,
    }),
  );
});

it('does not lose a fast operation that finishes between polls', () => {
  const { rerender } = renderHook(useDeviceOperationToasts, {
    initialProps: state(),
  });
  rerender(
    state({
      latestUpload: upload({
        status: 'failed',
        finishedAt,
        error: 'Нет ответа весов',
      }),
    }),
  );
  expect(toast.error).toHaveBeenCalledWith(
    'Ошибка загрузки на весы',
    expect.objectContaining({
      description: 'Нет ответа весов',
      duration: 10000,
    }),
  );
});

it('keeps clear loading until disconnect finishes and warns when disconnect fails', () => {
  const { rerender } = renderHook(useDeviceOperationToasts, {
    initialProps: state(),
  });
  const acknowledged = clear({
    status: 'completed',
    commandState: 'acknowledged',
  });
  expect(isDeviceOperationRunning(acknowledged)).toBe(true);
  rerender(state({ latestClear: acknowledged }));
  expect(toast.loading).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      description: expect.stringContaining('2/2'),
      duration: Infinity,
    }),
  );
  expect(toast.success).not.toHaveBeenCalled();
  rerender(
    state({
      latestClear: {
        ...acknowledged,
        finishedAt,
        disconnectError: 'Не удалось завершить связь',
      },
    }),
  );
  expect(toast.warning).toHaveBeenCalledWith(
    expect.stringContaining('Очистка подтверждена'),
    expect.objectContaining({
      description: expect.stringContaining('Не удалось завершить связь'),
      duration: 10000,
    }),
  );
  expect(toast.success).not.toHaveBeenCalled();
});

it('reports uncertain clearing as a warning without claiming successful deletion', () => {
  const { rerender } = renderHook(useDeviceOperationToasts, {
    initialProps: state(),
  });
  rerender(
    state({
      latestClear: clear({
        status: 'failed',
        finishedAt,
        commandState: 'uncertain',
        error: 'Нет ответа',
      }),
    }),
  );
  expect(toast.warning).toHaveBeenCalledWith(
    'Результат очистки неизвестен',
    expect.objectContaining({
      description: expect.stringContaining(
        'могла выполниться частично или полностью',
      ),
    }),
  );
  expect(toast.success).not.toHaveBeenCalled();
});

it('reports cancellation without error or success and dismisses active jobs when leaving the scope', () => {
  const { rerender, unmount } = renderHook(useDeviceOperationToasts, {
    initialProps: state({ latestUpload: upload() }),
  });
  rerender(
    state({
      latestUpload: upload({
        status: 'cancelled',
        finishedAt,
        error: 'Aborted',
      }),
    }),
  );
  expect(toast.warning).toHaveBeenCalledWith(
    'Загрузка остановлена',
    expect.any(Object),
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  rerender(state({ latestClear: clear() }));
  rerender(
    state({
      scope: { ...scope, storeId: 'another-store' },
      latestClear: clear({ status: 'failed', finishedAt }),
    }),
  );
  expect(toast.dismiss).toHaveBeenCalledWith('catalog-clear-clear-1');
  expect(toast.error).not.toHaveBeenCalled();
  rerender(
    state({
      scope: { ...scope, storeId: 'another-store' },
      latestClear: clear({ id: 'clear-2' }),
    }),
  );
  unmount();
  expect(toast.dismiss).toHaveBeenCalledWith('catalog-clear-clear-2');
});

it('restores a loading notification during Strict Mode effect remounts', () => {
  const { unmount } = renderHook(useDeviceOperationToasts, {
    initialProps: state({ latestUpload: upload() }),
    wrapper: StrictMode,
  });
  expect(toast.loading).toHaveBeenLastCalledWith(
    'Загружаем товары на весы…',
    expect.objectContaining({ id: 'catalog-upload-upload-1' }),
  );
  unmount();
  expect(toast.dismiss).toHaveBeenLastCalledWith('catalog-upload-upload-1');
});

it.each([
  [
    { status: 'completed', commandState: 'acknowledged' },
    'success',
    'Очистка завершена',
  ],
  [
    { status: 'failed', commandState: 'rejected', error: 'Команда отклонена' },
    'error',
    'Ошибка очистки весов',
  ],
  [
    { status: 'cancelled', commandState: 'pending' },
    'warning',
    'Очистка остановлена',
  ],
] as const)(
  'uses the actual terminal clear outcome %j',
  (outcome, kind, title) => {
    const { rerender } = renderHook(useDeviceOperationToasts, {
      initialProps: state(),
    });
    rerender(state({ latestClear: clear({ ...outcome, finishedAt }) }));
    expect(toast[kind]).toHaveBeenCalledWith(
      title,
      expect.objectContaining({ id: 'catalog-clear-clear-1' }),
    );
    expect(toast.loading).not.toHaveBeenCalled();
  },
);

it('warns about an upload disconnect failure after the device acknowledged its products', () => {
  const job = upload();
  const { rerender } = renderHook(useDeviceOperationToasts, {
    initialProps: state({ latestUpload: job }),
  });
  rerender(
    state({
      latestUpload: {
        ...job,
        status: 'completed',
        finishedAt,
        disconnectError: 'Нет ответа на disconnect',
        items: [{ ...job.items[0]!, state: 'acknowledged' }],
      },
    }),
  );
  expect(toast.warning).toHaveBeenCalledWith(
    'Загрузка завершена с предупреждением',
    expect.objectContaining({
      description: expect.stringContaining('Нет ответа на disconnect'),
    }),
  );
  expect(toast.success).not.toHaveBeenCalled();
});

it('never claims successful upload when some products have no acknowledgement', () => {
  const { rerender } = renderHook(useDeviceOperationToasts, {
    initialProps: state(),
  });
  rerender(
    state({ latestUpload: upload({ status: 'completed', finishedAt }) }),
  );
  expect(toast.warning).toHaveBeenCalledWith(
    'Не все товары подтверждены весами',
    expect.any(Object),
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(isDeviceOperationRunning(null)).toBe(false);
  expect(
    isDeviceOperationRunning(upload({ status: 'running', finishedAt })),
  ).toBe(true);
  expect(
    isDeviceOperationRunning(upload({ status: 'completed', finishedAt })),
  ).toBe(false);
});
