import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CatalogApi,
  type CatalogRequest,
  type CatalogState,
  emptyCatalogState,
} from '../../shared/catalog';
import App from './App';
import { configureAccessTokenProvider } from './common/api';
import { request } from './common/api/request';
import { CatalogAuthBridge } from './common/lib/catalog-session';
import { createQueryClient } from './common/lib/query-client';
import { authTokenProvider, useAuthStore } from './features/auth';
import {
  readStoredAccessToken,
  storeAccessToken,
} from './features/auth/stores/access-token.storage';

const token = `h.${btoa(JSON.stringify({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 600 }))}.s`;
const user = {
  id: 'user-1',
  email: 'manager@example.kz',
  phone: '+77771234567',
  first_name: 'Айгуль',
  last_name: 'Серикова',
  is_onboarded: true,
  created_at: '2026-10-01T00:00:00Z',
};
const originalAdapter = request.defaults.adapter;
const originalInitialize = useAuthStore.getState().initialize;
let queryClient: ReturnType<typeof createQueryClient>;
const context = {
  storeId: null,
  permissions: [],
  storeScope: {
    canAccessAll: false,
    storeIds: [],
    primaryStoreId: null,
    stores: [],
  },
};

const response = (config: InternalAxiosRequestConfig, data: unknown) => ({
  config,
  data: { data },
  status: 200,
  statusText: 'OK',
  headers: {},
});

beforeEach(() => {
  sessionStorage.clear();
  useAuthStore.setState({ initialize: originalInitialize });
  useAuthStore.setState({
    accessToken: null,
    authGeneration: 0,
    isInitialized: true,
    isInitializing: false,
    isLoggingOut: false,
  });
  configureAccessTokenProvider(authTokenProvider);
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false },
    mutations: { retry: false },
  });
});

afterEach(() => {
  queryClient.clear();
  request.defaults.adapter = originalAdapter;
  sessionStorage.clear();
  Object.defineProperty(window, 'catalog', {
    configurable: true,
    value: undefined,
  });
});

const renderApp = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <CatalogAuthBridge />
      <App />
    </QueryClientProvider>,
  );

const installOfflineCatalog = () => {
  let local: CatalogState = {
    ...emptyCatalogState(),
    access: 'offline',
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scope: {
      apiUrl: 'https://api.example.test',
      userId: 'user',
      membershipId: 'member',
      organizationId: 'org',
      storeId: 'store',
      storeName: 'Сохранённый магазин',
    },
    sync: {
      phase: 'idle',
      loaded: 1,
      lastSyncedAt: '2026-10-11T10:00:00Z',
      error: null,
    },
    total: 1,
    profile: {
      format: 'ean13-weight-v1',
      prefix: '21',
      enabled: true,
      blocked_reason: null,
      revision: 0,
      issued_plu_ranges: [[1, 1]],
    },
  };
  const listeners = new Set<() => void>();
  const catalogRequest = vi.fn(
    async (input: CatalogRequest): Promise<unknown> => {
      if (input.type === 'state') return local;
      if (input.type === 'adapters') return [];
      if (input.type === 'list')
        return {
          total: 1,
          products: [
            {
              id: 'apple',
              organization_id: 'org',
              store_id: 'store',
              name: 'Сохранённые яблоки',
              scale_name: null,
              scale_plu: 1,
              barcode: '123',
              unit: 'kg',
              retail_price: '100.00',
              is_active: true,
              updated_at: '2026-10-11T10:00:00Z',
              issues: [],
            },
          ],
        };
      throw new Error(`Unexpected catalog request: ${input.type}`);
    },
  );
  Object.defineProperty(window, 'catalog', {
    configurable: true,
    value: {
      request: catalogRequest as CatalogApi['request'],
      onChange: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onRefreshRequired: () => () => {},
    },
  });
  return {
    request: catalogRequest,
    scope: local.scope!,
    update: (next: CatalogState): void => {
      local = next;
      listeners.forEach((listener) => listener());
    },
  };
};

describe('sign-in flow', () => {
  it('opens the cached store with a matching sessionStorage token while the server is unavailable', async () => {
    const catalog = installOfflineCatalog();
    const claims = {
      sub: catalog.scope.userId,
      userOrganizationId: catalog.scope.membershipId,
      organizationId: catalog.scope.organizationId,
      storeId: catalog.scope.storeId,
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const storedToken = `h.${btoa(JSON.stringify(claims))}.s`;
    storeAccessToken(storedToken);
    useAuthStore.setState({
      accessToken: readStoredAccessToken(),
      isInitialized: false,
    });
    request.defaults.adapter = async (config) => {
      throw new AxiosError('Network unavailable', 'ERR_NETWORK', config);
    };
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    expect(
      catalog.request.mock.calls.some(([input]) => input.type === 'list'),
    ).toBe(false);
    await userEvent.click(
      screen.getByRole('button', { name: 'Открыть каталог' }),
    );
    expect(await screen.findByText('Сохранённые яблоки')).toBeVisible();
    expect(screen.getByText(/Нет соединения с Maria/)).toBeVisible();
    expect(useAuthStore.getState().accessToken).toBe(storedToken);
    await waitFor(() =>
      expect(catalog.request).toHaveBeenCalledWith({
        type: 'connect',
        accessToken: storedToken,
      }),
    );
    await act(async () =>
      catalog.update({
        ...emptyCatalogState(),
        error: 'Доступ к каталогу запрещён.',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText('Сохранённые яблоки')).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('heading', { name: 'Рабочее место' }),
    ).not.toBeInTheDocument();
  });

  it.each(['sub', 'userOrganizationId', 'organizationId', 'storeId'])(
    'does not open a cached scope when the token %s differs, even after an initialization error',
    async (field) => {
      const catalog = installOfflineCatalog();
      const claims = {
        sub: catalog.scope.userId,
        userOrganizationId: catalog.scope.membershipId,
        organizationId: catalog.scope.organizationId,
        storeId: catalog.scope.storeId,
        exp: Math.floor(Date.now() / 1000) + 600,
        [field]: 'different',
      };
      useAuthStore.setState({
        accessToken: `h.${btoa(JSON.stringify(claims))}.s`,
        isInitialized: false,
        initialize: async () => {
          throw new AxiosError('Network unavailable', 'ERR_NETWORK');
        },
      });
      renderApp();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Нет соединения с сервером',
      );
      expect(screen.queryByText('Сохранённые яблоки')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'Рабочее место' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Открыть каталог' }),
      ).not.toBeInTheDocument();
      expect(
        catalog.request.mock.calls.some(([input]) => input.type === 'list'),
      ).toBe(false);
    },
  );

  it('opens the saved catalog after a cold offline start and hides it when local access expires', async () => {
    const initialize = vi.fn(async () => {
      throw new AxiosError('Network unavailable', 'ERR_NETWORK');
    });
    useAuthStore.setState({
      accessToken: null,
      isInitialized: false,
      initialize,
    });
    const catalog = installOfflineCatalog();
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    expect(screen.getByText('Сохранённый магазин')).toBeVisible();
    expect(
      catalog.request.mock.calls.some(([input]) => input.type === 'list'),
    ).toBe(false);
    await userEvent.click(
      screen.getByRole('button', { name: 'Открыть каталог' }),
    );
    expect(await screen.findByText('Сохранённые яблоки')).toBeVisible();
    expect(screen.queryByText('Сохранённый магазин')).not.toBeInTheDocument();
    expect(screen.getByText(/Нет соединения с Maria/)).toBeVisible();
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(initialize).toHaveBeenCalledOnce();
    expect(
      catalog.request.mock.calls.some(([input]) =>
        ['connect', 'sync', 'upload'].includes(input.type),
      ),
    ).toBe(false);
    await act(async () => {
      catalog.update({
        ...emptyCatalogState(),
        error: 'Локальный доступ истёк',
      });
    });
    await waitFor(() =>
      expect(screen.queryByText('Сохранённые яблоки')).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('heading', { name: 'Рабочее место' }),
    ).not.toBeInTheDocument();
  });

  it('validates credentials, toggles password visibility, signs in as web and logs out', async () => {
    const sent: Array<{ url?: string; data: unknown }> = [];
    let finishLogin!: () => void;
    request.defaults.adapter = async (config) => {
      sent.push({ url: config.url, data: JSON.parse(config.data ?? '{}') });
      if (config.url === '/v1/auth/login') {
        await new Promise<void>((resolve) => {
          finishLogin = resolve;
        });
        return response(config, { auth: { access_token: token }, user });
      }
      if (config.url === '/v1/users/me') return response(config, { user });
      if (config.url === '/v1/auth/context')
        return response(config, { context });
      if (config.url === '/v1/organizations')
        return response(config, { organizations: [] });
      if (config.url === '/v1/auth/logout') return response(config, {});
      throw new Error(`Unexpected request: ${config.url}`);
    };
    const browser = userEvent.setup();
    renderApp();

    await browser.click(screen.getByRole('button', { name: 'Войти' }));
    expect(screen.getByText('Введите email или телефон')).toBeVisible();
    expect(screen.getByText('Введите пароль')).toBeVisible();
    expect(sent).toEqual([]);

    await browser.type(
      screen.getByLabelText('Email или телефон'),
      '  manager@example.kz  ',
    );
    await browser.type(
      screen.getByLabelText('Пароль', { exact: true }),
      'secure-pass',
    );
    await browser.click(
      screen.getByRole('button', { name: 'Показать пароль' }),
    );
    expect(screen.getByLabelText('Пароль', { exact: true })).toHaveAttribute(
      'type',
      'text',
    );
    await browser.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.getByRole('button', { name: /Войти/ })).toBeDisabled();
    expect(sent[0]).toEqual({
      url: '/v1/auth/login',
      data: {
        login: 'manager@example.kz',
        password: 'secure-pass',
        client_type: 'web',
      },
    });
    await act(async () => finishLogin());

    expect(await screen.findByText('Айгуль Серикова')).toBeVisible();
    expect(screen.getByText('manager@example.kz')).toBeVisible();
    expect(useAuthStore.getState().accessToken).toBe(token);
    await browser.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(
      await screen.findByRole('heading', { name: 'Вход в DukenAI Scales' }),
    ).toBeVisible();
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(sent.some(({ url }) => url === '/v1/auth/logout')).toBe(true);
  });

  it('shows server login errors and allows retry with the same credentials', async () => {
    let rejectLogin = true;
    request.defaults.adapter = async (config) => {
      if (config.url === '/v1/auth/context')
        return response(config, { context });
      if (config.url === '/v1/organizations')
        return response(config, { organizations: [] });
      if (config.url === '/v1/auth/login' && rejectLogin) {
        throw new AxiosError('Unauthorized', undefined, config, undefined, {
          ...response(config, {}),
          status: 401,
          data: { error_code: 'INVALID_CREDENTIALS' },
        });
      }
      return response(
        config,
        config.url === '/v1/auth/login'
          ? { auth: { access_token: token }, user }
          : { user },
      );
    };
    const browser = userEvent.setup();
    renderApp();
    await browser.type(
      screen.getByLabelText('Email или телефон'),
      'manager@example.kz',
    );
    await browser.type(
      screen.getByLabelText('Пароль', { exact: true }),
      'secure-pass',
    );
    await browser.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Неверный email, телефон или пароль.',
    );
    expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled();
    rejectLogin = false;
    await browser.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByText('Айгуль Серикова')).toBeVisible();
  });

  it('keeps an existing session when loading the user fails and can retry', async () => {
    useAuthStore.setState({ accessToken: token });
    let unavailable = true;
    request.defaults.adapter = async (config) => {
      if (unavailable)
        throw new AxiosError('Network unavailable', 'ERR_NETWORK', config);
      if (config.url === '/v1/auth/context')
        return response(config, { context });
      if (config.url === '/v1/organizations')
        return response(config, { organizations: [] });
      return response(config, { user });
    };
    const browser = userEvent.setup();
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Нет соединения с сервером',
    );
    expect(useAuthStore.getState().accessToken).toBe(token);
    unavailable = false;
    await browser.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Айгуль Серикова')).toBeVisible();
  });
});
