import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureAccessTokenProvider } from '../../common/api';
import { request } from '../../common/api/request';
import { createQueryClient } from '../../common/lib/query-client';
import { authTokenProvider, useAuthStore } from '../auth';
import { StatusBarProvider, useStatusBar } from './status-bar-context';
import { StatusBarSession } from './status-bar-session';

const originalAdapter = request.defaults.adapter;
const originalLogout = useAuthStore.getState().logout;
const token = `h.${btoa(JSON.stringify({ sub: 'user', exp: Math.floor(Date.now() / 1000) + 600 }))}.s`;
let queryClient: ReturnType<typeof createQueryClient>;
let membershipStatus = 'ACTIVE';
let gate: Promise<void> | null = null;
const respond = (config: InternalAxiosRequestConfig, data: unknown) => ({
  config,
  data: { data },
  status: 200,
  statusText: 'OK',
  headers: {},
});

function PublishedStatus() {
  const value = useStatusBar();
  return (
    <>
      <p data-testid="context">{value.contextName ?? 'Нет контекста'}</p>
      <p data-testid="user">
        {value.user
          ? `${value.user.fullName} / ${value.user.position}`
          : 'Нет пользователя'}
      </p>
      {value.logoutError ? <p role="alert">{value.logoutError}</p> : null}
      {value.logout ? (
        <button onClick={value.logout} disabled={value.isLoggingOut}>
          Выйти
        </button>
      ) : null}
    </>
  );
}

const tree = (session = true) => (
  <StatusBarProvider>
    <QueryClientProvider client={queryClient}>
      {session ? <StatusBarSession /> : null}
      <PublishedStatus />
    </QueryClientProvider>
  </StatusBarProvider>
);

beforeEach(() => {
  sessionStorage.clear();
  membershipStatus = 'ACTIVE';
  gate = null;
  queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false },
    mutations: { retry: false },
  });
  useAuthStore.setState({
    accessToken: token,
    authGeneration: 0,
    isLoggingOut: false,
    isInitialized: true,
    logout: originalLogout,
  });
  configureAccessTokenProvider(authTokenProvider);
  request.defaults.adapter = async (config) => {
    await gate;
    if (config.url === '/v1/users/me')
      return respond(config, {
        user: {
          id: 'user',
          first_name: 'Айгуль',
          last_name: 'Серикова',
          email: 'operator@example.kz',
        },
      });
    if (config.url === '/v1/auth/context')
      return respond(config, {
        context: {
          userOrganizationId: 'member',
          organizationId: 'org',
          storeId: 'store',
          position: 'Администратор',
          permissions: [],
          storeScope: { stores: [{ id: 'store', name: 'Центральный' }] },
        },
      });
    if (config.url === '/v1/organizations')
      return respond(config, {
        organizations: [
          {
            membership_id: 'member',
            status: membershipStatus,
            organization: { id: 'org', name: 'Мария' },
            position: null,
          },
        ],
      });
    throw new Error(`Unexpected request: ${config.url}`);
  };
});
afterEach(() => {
  queryClient.clear();
  request.defaults.adapter = originalAdapter;
  useAuthStore.setState({ logout: originalLogout });
  sessionStorage.clear();
});

describe('status bar session bridge', () => {
  it('publishes verified context and user, hides the old generation, and clears on unmount', async () => {
    const mounted = render(tree());
    expect(await screen.findByText('Мария · Центральный')).toBeVisible();
    expect(screen.getByTestId('user')).toHaveTextContent(
      'Айгуль Серикова / Администратор',
    );
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    act(() => useAuthStore.setState({ authGeneration: 1 }));
    await waitFor(() =>
      expect(screen.getByTestId('context')).toHaveTextContent('Нет контекста'),
    );
    expect(screen.getByTestId('user')).toHaveTextContent('Нет пользователя');
    await act(async () => {
      release();
    });
    expect(await screen.findByText('Мария · Центральный')).toBeVisible();
    mounted.rerender(tree(false));
    await waitFor(() =>
      expect(screen.getByTestId('user')).toHaveTextContent('Нет пользователя'),
    );
    expect(
      screen.queryByRole('button', { name: 'Выйти' }),
    ).not.toBeInTheDocument();
  });

  it('does not publish a suspended membership as the selected organization', async () => {
    membershipStatus = 'SUSPENDED';
    render(tree());
    await screen.findByText(/Айгуль Серикова/);
    expect(screen.getByTestId('context')).toHaveTextContent('Нет контекста');
    expect(screen.getByTestId('user')).toHaveTextContent('Сотрудник');
  });

  it('uses the existing logout action and publishes an actionable failure', async () => {
    const logout = vi.fn(async () => {
      throw new AxiosError('Offline', 'ERR_NETWORK');
    });
    useAuthStore.setState({ logout });
    const browser = userEvent.setup();
    render(tree());
    await browser.click(await screen.findByRole('button', { name: 'Выйти' }));
    expect(logout).toHaveBeenCalledOnce();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Нет соединения с сервером',
    );
    act(() => useAuthStore.setState({ accessToken: null, authGeneration: 1 }));
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Выйти' }),
    ).not.toBeInTheDocument();
  });

  it('works without a status provider so existing isolated app tests stay valid', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <StatusBarSession />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  });
});
