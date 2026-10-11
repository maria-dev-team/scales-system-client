import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import App from '../../App';
import { configureAccessTokenProvider } from '../../common/api';
import { request } from '../../common/api/request';
import { createQueryClient } from '../../common/lib/query-client';
import { authTokenProvider, useAuthStore } from './stores/auth-store';

const tokenExpiration = Math.floor(Date.now() / 1000) + 600;
const tokenFor = (membership?: string, store?: string) =>
  `h.${btoa(JSON.stringify({ sub: 'operator', userOrganizationId: membership, organizationId: membership ? `org-${membership}` : undefined, storeId: store, exp: tokenExpiration }))}.s`;
const membership = (id: string, name: string, status = 'ACTIVE') => ({
  membership_id: id,
  organization: {
    id: `org-${id}`,
    name,
    address: null,
    bin_iin: null,
    created_at: '2026-10-01',
    updated_at: '2026-10-01',
    deleted_at: null,
    default_currency: 'KZT',
    language: 'ru',
    legal_form: 'ИП',
    legal_name: name,
    timezone: 'Asia/Almaty',
    trade_name: null,
  },
  position: null,
  status,
});
const memberships = [
  membership('member-a', 'Мария'),
  membership('member-b', 'Другая организация'),
];
const stores = [
  { id: 'store-a', name: 'Центральный', address: 'Абая, 10' },
  { id: 'store-b', name: 'Восточный', address: null },
];
const user = {
  id: 'operator',
  first_name: 'Айгуль',
  last_name: 'Серикова',
  email: 'operator@example.kz',
  phone: '',
  is_onboarded: true,
  created_at: '2026-10-01',
};
const contextFor = (
  member?: string,
  store: string | null = null,
  available = stores,
) => ({
  userOrganizationId: member,
  organizationId: member ? `org-${member}` : undefined,
  storeId: store,
  permissions: ['product.read'],
  storeScope: {
    canAccessAll: false,
    primaryStoreId: available[0]?.id ?? null,
    storeIds: available.map(({ id }) => id),
    stores: member ? available : [],
  },
});
const respond = (config: InternalAxiosRequestConfig, data: unknown) => ({
  config,
  data: { data },
  status: 200,
  statusText: 'OK',
  headers: {},
});
const originalAdapter = request.defaults.adapter;
let queryClient: ReturnType<typeof createQueryClient>;
let context: ReturnType<typeof contextFor>;
let organizations: Array<ReturnType<typeof membership>>;
let selections: Array<{ user_organization_id: string; store_id?: string }>;
let selectGate: (() => Promise<void>) | undefined;
let organizationsUnavailable: boolean;

beforeEach(() => {
  sessionStorage.clear();
  context = contextFor();
  organizations = [...memberships];
  selections = [];
  selectGate = undefined;
  organizationsUnavailable = false;
  useAuthStore.setState({
    accessToken: tokenFor(),
    authGeneration: 0,
    isInitialized: true,
    isInitializing: false,
    isLoggingOut: false,
  });
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false },
    mutations: { retry: false },
  });
  configureAccessTokenProvider({
    ...authTokenProvider,
    resyncAuth: () => queryClient.removeQueries(),
  });
  request.defaults.adapter = async (config) => {
    if (config.url === '/v1/users/me') return respond(config, { user });
    if (config.url === '/v1/auth/context') return respond(config, { context });
    if (config.url === '/v1/organizations') {
      if (organizationsUnavailable)
        throw new AxiosError('Network', 'ERR_NETWORK', config);
      return respond(config, { organizations });
    }
    if (config.url === '/v1/auth/select-context') {
      const input = JSON.parse(config.data);
      selections.push(input);
      await selectGate?.();
      const selectedStores =
        input.user_organization_id === 'member-b'
          ? [{ id: 'store-c', name: 'Другой магазин', address: 'Достык, 1' }]
          : stores;
      // Backend can automatically choose the primary store when selecting a membership.
      context = contextFor(
        input.user_organization_id,
        input.store_id ?? selectedStores[0]!.id,
        selectedStores,
      );
      return respond(config, {
        auth: {
          access_token: tokenFor(input.user_organization_id, context.storeId!),
        },
      });
    }
    if (config.url === '/v1/auth/logout') return respond(config, {});
    throw new Error(`Unexpected request: ${config.url}`);
  };
});
afterEach(() => {
  queryClient.clear();
  request.defaults.adapter = originalAdapter;
  sessionStorage.clear();
});
const renderApp = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );

describe('organization and store selection', () => {
  it('selects a membership, asks for a store even when the server chooses a primary store, and commits the selected context', async () => {
    const browser = userEvent.setup();
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Выберите организацию' }),
    ).toBeVisible();
    await browser.click(await screen.findByRole('button', { name: /Мария/ }));
    expect(
      await screen.findByRole('heading', { name: 'Выберите магазин' }),
    ).toBeVisible();
    await browser.click(
      await screen.findByRole('button', { name: /Восточный/ }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    expect(screen.getByText('Восточный')).toBeVisible();
    expect(screen.getByText('Мария')).toBeVisible();
    expect(selections).toEqual([
      { user_organization_id: 'member-a' },
      { user_organization_id: 'member-a', store_id: 'store-b' },
    ]);
    expect(useAuthStore.getState().accessToken).toBe(
      tokenFor('member-a', 'store-b'),
    );
  });

  it('restores a valid store and allows selecting another store or organization', async () => {
    context = contextFor('member-a', 'store-a');
    useAuthStore.setState({ accessToken: tokenFor('member-a', 'store-a') });
    const browser = userEvent.setup();
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    await browser.click(
      screen.getByRole('button', { name: 'Сменить магазин' }),
    );
    await browser.click(
      await screen.findByRole('button', { name: 'Выбрать другую организацию' }),
    );
    await browser.click(
      await screen.findByRole('button', { name: /Другая организация/ }),
    );
    expect(
      await screen.findByRole('button', { name: /Другой магазин/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Центральный/ }),
    ).not.toBeInTheDocument();
    await browser.click(screen.getByRole('button', { name: /Другой магазин/ }));
    expect(
      await screen.findByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    expect(screen.getByText('Другой магазин')).toBeVisible();
    expect(selections.at(-1)).toEqual({
      user_organization_id: 'member-b',
      store_id: 'store-c',
    });
  });

  it('still asks for a store after leaving and reopening Maria midway through selection', async () => {
    const browser = userEvent.setup();
    const mounted = renderApp();
    await browser.click(await screen.findByRole('button', { name: /Мария/ }));
    expect(
      await screen.findByRole('heading', { name: 'Выберите магазин' }),
    ).toBeVisible();
    await screen.findByRole('button', { name: /Центральный/ });
    mounted.unmount();
    const reopened = renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Выберите магазин' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Рабочее место' }),
    ).not.toBeInTheDocument();
    await browser.click(
      await screen.findByRole('button', { name: /Восточный/ }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    reopened.unmount();
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    expect(screen.getByText('Восточный')).toBeVisible();
  });

  it('requires selection when the restored store is no longer in the accessible scope', async () => {
    context = contextFor('member-a', 'removed-store');
    useAuthStore.setState({
      accessToken: tokenFor('member-a', 'removed-store'),
    });
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Выберите магазин' }),
    ).toBeVisible();
    expect(
      await screen.findByRole('button', { name: /Центральный/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Рабочее место' }),
    ).not.toBeInTheDocument();
  });

  it('preserves selection progress when Maria is reopened during either selection request', async () => {
    let finishSelection!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishSelection = resolve;
    });
    selectGate = () => pending;
    const browser = userEvent.setup();
    const mounted = renderApp();
    await browser.click(await screen.findByRole('button', { name: /Мария/ }));
    await waitFor(() => expect(selections).toHaveLength(1));
    mounted.unmount();
    const reopened = renderApp();
    await act(async () => finishSelection());
    expect(
      await screen.findByRole('button', { name: /Восточный/ }),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Рабочее место' }),
    ).not.toBeInTheDocument();
    const storePending = new Promise<void>((resolve) => {
      finishSelection = resolve;
    });
    selectGate = () => storePending;
    await browser.click(screen.getByRole('button', { name: /Восточный/ }));
    await waitFor(() => expect(selections).toHaveLength(2));
    reopened.unmount();
    renderApp();
    await act(async () => finishSelection());
    expect(
      await screen.findByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    expect(screen.getByText('Восточный')).toBeVisible();
  });

  it('excludes suspended memberships and shows an empty state with logout', async () => {
    organizations = [membership('blocked', 'Заблокированная', 'SUSPENDED')];
    const browser = userEvent.setup();
    renderApp();
    expect(await screen.findByText('Нет доступных организаций')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Заблокированная/ }),
    ).not.toBeInTheDocument();
    await browser.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(
      await screen.findByRole('heading', { name: 'Вход в DukenAI Scales' }),
    ).toBeVisible();
  });

  it('offers another organization when there are no accessible stores', async () => {
    context = contextFor('member-a', null, []);
    useAuthStore.setState({ accessToken: tokenFor('member-a') });
    const browser = userEvent.setup();
    renderApp();
    expect(await screen.findByText('Нет доступных магазинов')).toBeVisible();
    await browser.click(
      screen.getByRole('button', { name: 'Выбрать другую организацию' }),
    );
    expect(
      await screen.findByRole('button', { name: /Другая организация/ }),
    ).toBeVisible();
  });

  it('retries a failed organization request without losing the login', async () => {
    organizationsUnavailable = true;
    const browser = userEvent.setup();
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Нет соединения с сервером',
    );
    organizationsUnavailable = false;
    await browser.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('button', { name: /Мария/ })).toBeVisible();
    expect(useAuthStore.getState().accessToken).not.toBeNull();
  });

  it('disables choices during selection and permits retry after a rejected selection', async () => {
    let rejectSelection!: (error: Error) => void;
    selectGate = () =>
      new Promise<void>((_resolve, reject) => {
        rejectSelection = reject;
      });
    const browser = userEvent.setup();
    renderApp();
    await browser.click(await screen.findByRole('button', { name: /Мария/ }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Другая организация/ }),
      ).toBeDisabled(),
    );
    expect(selections).toHaveLength(1);
    await act(async () => rejectSelection(new Error('Выбор отклонён')));
    expect(await screen.findByRole('alert')).toBeVisible();
    selectGate = undefined;
    await browser.click(await screen.findByRole('button', { name: /Мария/ }));
    expect(
      await screen.findByRole('heading', { name: 'Выберите магазин' }),
    ).toBeVisible();
  });

  it('hides the old store when the refreshed session loses its organization', async () => {
    context = contextFor('member-a', 'store-a');
    useAuthStore.setState({ accessToken: tokenFor('member-a', 'store-a') });
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Рабочее место' }),
    ).toBeVisible();
    context = contextFor();
    act(() => useAuthStore.getState().setAccessToken(tokenFor(), true));
    expect(
      await screen.findByRole('heading', { name: 'Выберите организацию' }),
    ).toBeVisible();
    expect(screen.queryByText('Центральный')).not.toBeInTheDocument();
  });

  it('does not restore a pending selection after logout', async () => {
    let finishSelection!: () => void;
    selectGate = () =>
      new Promise<void>((resolve) => {
        finishSelection = resolve;
      });
    const browser = userEvent.setup();
    renderApp();
    await browser.click(await screen.findByRole('button', { name: /Мария/ }));
    await waitFor(() => expect(selections).toHaveLength(1));
    await browser.click(screen.getByRole('button', { name: 'Выйти' }));
    await act(async () => finishSelection());
    expect(
      await screen.findByRole('heading', { name: 'Вход в DukenAI Scales' }),
    ).toBeVisible();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
