import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  logout: vi.fn(),
  refreshTokens: vi.fn(),
}));

vi.mock('@renderer/common/api', () => api);

const loadStore = async () => {
  vi.resetModules();
  return (await import('./auth-store')).useAuthStore;
};

beforeEach(() => {
  sessionStorage.clear();
  api.logout.mockReset();
  api.refreshTokens.mockReset();
});

afterEach(() => sessionStorage.clear());

describe('auth store', () => {
  it('restores an access token with the refresh cookie', async () => {
    api.refreshTokens.mockResolvedValue({ access_token: 'fresh-token' });
    const store = await loadStore();

    await store.getState().initialize();

    expect(store.getState()).toMatchObject({
      accessToken: 'fresh-token',
      isInitialized: true,
      isInitializing: false,
    });
  });

  it('finishes initialization as a guest only when refresh returns 401', async () => {
    api.refreshTokens.mockRejectedValue(
      new AxiosError('No session', undefined, undefined, undefined, {
        status: 401,
      } as never),
    );
    const store = await loadStore();

    await store.getState().initialize();

    expect(store.getState()).toMatchObject({
      accessToken: null,
      isInitialized: true,
    });
  });

  it('preserves a retryable restoration failure and succeeds on retry', async () => {
    api.refreshTokens
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({ access_token: 'fresh-token' });
    const store = await loadStore();
    await expect(store.getState().initialize()).rejects.toThrow(
      'Network unavailable',
    );
    expect(store.getState().isInitialized).toBe(false);
    await store.getState().initialize();
    expect(store.getState().accessToken).toBe('fresh-token');
  });

  it('does not restore a session after logout starts with no token', async () => {
    let finish!: (value: unknown) => void;
    api.refreshTokens.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    api.logout.mockResolvedValue(undefined);
    const store = await loadStore();
    const pending = store.getState().initialize();
    const checked = expect(pending).rejects.toMatchObject({
      code: 'AUTH_CONTEXT_CHANGED',
    });
    await store.getState().logout();
    finish({ access_token: 'late-token' });
    await checked;
    expect(store.getState().accessToken).toBeNull();
  });

  it('keeps the local session when backend logout fails', async () => {
    api.logout.mockRejectedValue(new Error('Current cashier session'));
    const store = await loadStore();
    store.getState().setAccessToken('access-token');

    await expect(store.getState().logout()).rejects.toThrow(
      'Current cashier session',
    );

    expect(store.getState().accessToken).toBe('access-token');
    expect(store.getState().isLoggingOut).toBe(false);
  });

  it('clears the local session after backend logout succeeds', async () => {
    const store = await loadStore();
    api.logout.mockImplementation(async () =>
      store.getState().commitAccessToken(null),
    );
    store.getState().setAccessToken('access-token');

    await store.getState().logout();

    expect(store.getState().accessToken).toBeNull();
  });
});
