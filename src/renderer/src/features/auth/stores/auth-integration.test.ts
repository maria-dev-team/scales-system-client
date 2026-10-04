import axios, { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
});

async function fixture(status: { value: number }) {
  const accessToken = `h.${btoa(JSON.stringify({ sub: 'user', sessionId: 'session', exp: Math.floor(Date.now() / 1000) + 600 }))}.s`;
  const adapter = vi.fn(async (config) => {
    const response = {
      config,
      status: status.value,
      statusText: String(status.value),
      headers: {},
      data: { data: { auth: { access_token: accessToken } } },
    };
    if (status.value !== 200)
      throw new AxiosError(
        'Unavailable',
        undefined,
        config,
        undefined,
        response,
      );
    return response;
  });
  axios.defaults.adapter = adapter;
  const { useAuthStore, authTokenProvider } = await import('./auth-store');
  const { configureAccessTokenProvider } =
    await import('../../../common/api/access-token.provider');
  configureAccessTokenProvider(authTokenProvider);
  const { refreshAccessToken } = await import('../../../common/api/request');
  return { store: useAuthStore, adapter, accessToken, refreshAccessToken };
}

describe('auth store and shared refresh integration', () => {
  it('shares initialization and explicit recovery without changing generation on renewal', async () => {
    const f = await fixture({ value: 200 });
    await Promise.all([
      f.store.getState().initialize(),
      f.refreshAccessToken(),
    ]);
    expect(f.adapter).toHaveBeenCalledTimes(1);
    expect(f.store.getState()).toMatchObject({
      accessToken: f.accessToken,
      authGeneration: 0,
      isInitialized: true,
    });
    await f.refreshAccessToken();
    expect(f.store.getState().authGeneration).toBe(0);
  });

  it('advances generation when refresh removes a no-longer-accessible context', async () => {
    const f = await fixture({ value: 200 });
    const selected = `h.${btoa(JSON.stringify({ sub: 'user', sessionId: 'session', userOrganizationId: 'membership', organizationId: 'org', storeId: 'store' }))}.s`;
    f.store.getState().setAccessToken(selected);
    const generation = f.store.getState().authGeneration;
    await f.refreshAccessToken();
    expect(f.store.getState()).toMatchObject({
      accessToken: f.accessToken,
      authGeneration: generation + 1,
    });
  });

  it('commits logout through the serialized request before the store operation finishes', async () => {
    const f = await fixture({ value: 200 });
    f.store.getState().setAccessToken(f.accessToken);
    const generation = f.store.getState().authGeneration;
    await f.store.getState().logout();
    expect(f.store.getState()).toMatchObject({
      accessToken: null,
      authGeneration: generation + 1,
    });
    expect(f.adapter).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/v1/auth/logout' }),
    );
  });

  it('becomes guest after the shared coordinator rejects the refresh with 401', async () => {
    const f = await fixture({ value: 401 });
    await f.store.getState().initialize();
    expect(f.store.getState()).toMatchObject({
      accessToken: null,
      isInitialized: true,
    });
  });

  it.each([429, 503])(
    'keeps startup retryable after HTTP %s',
    async (value) => {
      const status = { value };
      const f = await fixture(status);
      await expect(f.store.getState().initialize()).rejects.toMatchObject({
        response: { status: value },
      });
      expect(f.store.getState().isInitialized).toBe(false);
      status.value = 200;
      await f.store.getState().initialize();
      expect(f.store.getState().accessToken).toBe(f.accessToken);
    },
  );
});
