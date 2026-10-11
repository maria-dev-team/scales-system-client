import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster, toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';

import {
  type CatalogApi,
  type CatalogRequest,
  type CatalogState,
  type UploadPreview,
  emptyCatalogState,
} from '../../../../shared/catalog';
import { CatalogView } from './catalog-view';

vi.mock('@renderer/common/lib/catalog-session', () => ({
  useCatalogSession: () => undefined,
}));

function mount() {
  let state: CatalogState = {
    ...emptyCatalogState(),
    access: 'online',
    total: 1,
    scope: {
      apiUrl: 'https://api.test',
      userId: 'user',
      membershipId: 'member',
      organizationId: 'org',
      storeId: 'store',
      storeName: 'Shop',
    },
    device: {
      scaleIp: '192.168.1.8',
      localAddress: '192.168.1.2',
      port: 5001,
      nameEncoding: 'ascii',
      barcodePrefix: '20',
      setupConfirmed: true,
    },
    profile: {
      prefix: '20',
      format: 'ean13-weight-v1',
      enabled: true,
      blocked_reason: null,
    },
    sync: {
      phase: 'idle',
      loaded: 1,
      lastSyncedAt: '2026-10-11T10:00:00Z',
      error: null,
    },
  };
  const product = {
    id: '00000000-0000-4000-8000-000000000001',
    organization_id: 'org',
    store_id: 'store',
    name: 'Apple',
    scale_name: null,
    scale_plu: 15,
    barcode: '123',
    unit: 'kg' as const,
    retail_price: '120.50',
    is_active: true,
    updated_at: '2026-10-11T10:00:00Z',
  };
  const preview: UploadPreview = {
    revision: 'a'.repeat(64),
    ready: [product],
    excluded: [],
    blockers: [],
    removalRequired: [],
    uncertainCount: 0,
    catalogSyncedAt: state.sync.lastSyncedAt,
  };
  let changed = () => {};
  const request = vi.fn(async (input: CatalogRequest): Promise<unknown> => {
    if (input.type === 'adapters') return [];
    if (input.type === 'list')
      return { products: [{ ...product, issues: [] }], total: 1 };
    if (input.type === 'preview') return preview;
    if (input.type === 'prepare-clear')
      return {
        token: '00000000-0000-4000-8000-000000000002',
        device: state.device,
        expiresAt: '2099-01-01T00:00:00Z',
      };
    return state;
  });
  Object.defineProperty(window, 'catalog', {
    configurable: true,
    value: {
      request: request as CatalogApi['request'],
      onChange: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
      onRefreshRequired: () => () => {},
    },
  });
  render(
    <>
      <CatalogView storeName="Shop" />
      <Toaster />
    </>,
  );
  return {
    request,
    getState: () => state,
    update: async (next: CatalogState) => {
      state = next;
      await act(async () => changed());
    },
  };
}

afterEach(() => {
  toast.dismiss();
  Object.defineProperty(window, 'catalog', {
    configurable: true,
    value: undefined,
  });
});

it('shows immediate clear preparation loading and prevents a second request', async () => {
  const harness = mount();
  await userEvent.click(
    await screen.findByRole('button', { name: 'Настроить весы' }),
  );
  let finish!: (value: unknown) => void;
  harness.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const button = screen.getByRole('button', {
    name: 'Удалить все товары с весов',
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
  expect(
    harness.request.mock.calls.filter(
      ([input]) => input.type === 'prepare-clear',
    ),
  ).toHaveLength(1);
  await act(async () =>
    finish({
      token: '00000000-0000-4000-8000-000000000002',
      device: harness.getState().device,
      expiresAt: '2099-01-01T00:00:00Z',
    }),
  );
  expect(
    await screen.findByRole('button', {
      name: 'Подтвердить удаление всех товаров',
    }),
  ).toBeDisabled();
});

it('shows a readable error toast and re-enables the action after rejection', async () => {
  const harness = mount();
  await userEvent.click(
    await screen.findByRole('button', { name: 'Настроить весы' }),
  );
  harness.request.mockRejectedValueOnce(
    new Error(
      "Error invoking remote method 'catalog:request': Error: Некорректные параметры операции каталога.",
    ),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Удалить все товары с весов' }),
  );
  const notices = await screen.findByRole('region', { name: /Notifications/ });
  expect(
    await within(notices).findByText(/Некорректные параметры/),
  ).toBeVisible();
  expect(notices).not.toHaveTextContent('Error invoking remote method');
  expect(
    screen.getByRole('button', { name: 'Удалить все товары с весов' }),
  ).toBeEnabled();
});

it('keeps upload progress visible after the request returns and only reports the final device result', async () => {
  const harness = mount();
  await userEvent.click(
    await screen.findByRole('button', { name: 'Открыть каталог' }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Подготовить весь каталог' }),
  );
  const button = await screen.findByRole('button', {
    name: 'Загрузить 1 товар на весы',
  });
  let finish!: (value: unknown) => void;
  harness.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toHaveAttribute('aria-busy', 'true');
  expect(button).toBeDisabled();
  expect(
    harness.request.mock.calls.filter(([input]) => input.type === 'upload'),
  ).toHaveLength(1);
  const next = {
    ...harness.getState(),
    latestUpload: {
      id: 'new-upload',
      scope: harness.getState().scope!,
      device: harness.getState().device!,
      catalogSyncedAt: '2026-10-11T10:00:00Z',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running' as const,
      items: [],
      events: [],
      error: null,
      disconnectError: null,
    },
  };
  await act(async () => finish(next));
  await harness.update(next);
  expect(
    screen.getByRole('progressbar', { name: 'Загрузка товаров на весы' }),
  ).toBeVisible();
  const notices = screen.getByRole('region', { name: /Notifications/ });
  expect(
    within(notices).queryByText('Загрузка завершена'),
  ).not.toBeInTheDocument();
  await harness.update({
    ...next,
    latestUpload: {
      ...next.latestUpload,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: 'Нет ответа весов',
    },
  });
  await waitFor(() =>
    expect(within(notices).getByText('Ошибка загрузки на весы')).toBeVisible(),
  );
  expect(within(notices).getByText(/Нет ответа весов/)).toBeVisible();
});
