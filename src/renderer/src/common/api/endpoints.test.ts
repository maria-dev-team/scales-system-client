import axios, {
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

const user = {
  created_at: '2026-08-23T00:00:00.000Z',
  email: 'operator@example.test',
  first_name: 'Maria',
  id: 'user-1',
  is_onboarded: true,
  last_name: 'Operator',
  phone: '+77771234567',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authentication endpoints', () => {
  it('logs in with the web client type, refreshes the session, loads the user and logs out', async () => {
    const calls: InternalAxiosRequestConfig[] = [];
    axios.defaults.adapter = async (config): Promise<AxiosResponse> => {
      calls.push(config);
      const dataByUrl: Record<string, unknown> = {
        '/v1/auth/login': {
          data: { auth: { access_token: 'login-token' }, user },
        },
        '/v1/auth/refresh': {
          data: { auth: { access_token: 'refreshed-token' } },
        },
        '/v1/users/me': { data: { user } },
        '/v1/auth/logout': {},
      };
      return {
        config,
        data: dataByUrl[config.url!],
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    };
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', 'http://localhost:4004');
    const {
      configureAccessTokenProvider,
      getCurrentUser,
      login,
      logout,
      refreshTokens,
    } = await import('./index');
    let token: string | null = null;
    configureAccessTokenProvider({
      getAccessToken: () => token,
      setAccessToken: (value) => {
        token = value;
      },
      clearAccessToken: () => {
        token = null;
      },
    });

    await expect(
      login({ login: 'operator@example.test', password: 'pass word' }),
    ).resolves.toEqual({ auth: { access_token: 'login-token' }, user });
    expect(JSON.parse(calls[0]?.data as string)).toEqual({
      login: 'operator@example.test',
      password: 'pass word',
      client_type: 'web',
    });
    expect(token).toBe('login-token');
    await expect(refreshTokens()).resolves.toEqual({
      access_token: 'refreshed-token',
    });
    await expect(getCurrentUser()).resolves.toEqual(user);
    expect(calls[2]?.headers.get('Authorization')).toBe(
      'Bearer refreshed-token',
    );
    await expect(logout()).resolves.toBeUndefined();
    expect(token).toBeNull();
    expect(calls.map(({ method, url }) => [method, url])).toEqual([
      ['post', '/v1/auth/login'],
      ['post', '/v1/auth/refresh'],
      ['get', '/v1/users/me'],
      ['post', '/v1/auth/logout'],
    ]);
    expect(calls.every(({ withCredentials }) => withCredentials)).toBe(true);
  });
});
