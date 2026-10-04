import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import App from './App';
import { configureAccessTokenProvider } from './common/api';
import { request } from './common/api/request';
import { createQueryClient } from './common/lib/query-client';
import { authTokenProvider, useAuthStore } from './features/auth';

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
let queryClient: ReturnType<typeof createQueryClient>;

const response = (config: InternalAxiosRequestConfig, data: unknown) => ({
  config,
  data: { data },
  status: 200,
  statusText: 'OK',
  headers: {},
});

beforeEach(() => {
  sessionStorage.clear();
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
});

const renderApp = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );

describe('sign-in flow', () => {
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
