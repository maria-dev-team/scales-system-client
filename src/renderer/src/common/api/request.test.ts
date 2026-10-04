import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

const response = (
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
): AxiosResponse => ({
  config,
  data,
  headers: {},
  status,
  statusText: String(status),
});

const unauthorized = (config: InternalAxiosRequestConfig): AxiosError =>
  new AxiosError(
    'Unauthorized',
    undefined,
    config,
    undefined,
    response(config, 401, { error_code: 'INVALID_TOKEN' }),
  );

const loadRequest = async (
  adapter: (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>,
) => {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', 'http://localhost:4004');
  axios.defaults.adapter = adapter;

  const token = { value: 'expired-token' as string | null, generation: 0 };
  const api = await import('./request');
  const provider = await import('./access-token.provider');
  const resync = vi.fn();
  provider.configureAccessTokenProvider({
    resyncAuth: resync,
    beginAuthChange: () => {
      token.generation++;
    },
    clearAccessToken: () => {
      token.value = null;
    },
    getAccessToken: () => token.value,
    getAuthGeneration: () => token.generation,
    setAccessToken: (accessToken) => {
      token.value = accessToken;
    },
  });

  return { ...api, token, resync };
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('request refresh flow', () => {
  it('captures ownership when the request is called, before Axios schedules dispatch', async () => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) =>
      response(config, 200, {}),
    );
    const f = await loadRequest(adapter);
    const pending = f.request.post('/sale', {});
    f.token.generation++;
    await expect(pending).rejects.toMatchObject({
      code: 'AUTH_CONTEXT_CHANGED',
    });
  });

  it('rejects a successful old response after a same-token auth operation starts', async () => {
    let finish!: () => void;
    const { request, token } = await loadRequest(async (config) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return response(config, 200, { data: 'old context' });
    });
    const pending = request.get('/protected');
    const checked = expect(pending).rejects.toMatchObject({
      code: 'AUTH_CONTEXT_CHANGED',
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    token.generation++;
    finish();
    await checked;
  });

  it('waits for an ongoing refresh before dispatching a protected request', async () => {
    let finish!: () => void;
    const sent: string[] = [];
    const { request, refreshAccessToken } = await loadRequest(
      async (config) => {
        if (config.url === '/v1/auth/refresh') {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return response(config, 200, {
            data: { auth: { access_token: 'new-token' } },
          });
        }
        sent.push(String(config.headers.get('Authorization')));
        return response(config, 200, {});
      },
    );
    const refreshing = refreshAccessToken();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const pending = request.get('/protected');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([]);
    finish();
    await Promise.all([refreshing, pending]);
    expect(sent).toEqual(['Bearer new-token']);
  });

  it('updates sanitized server context without replaying a mutation and requests resync', async () => {
    const jwt = (storeId: string | null) =>
      `header.${btoa(JSON.stringify({ sub: 'user', sessionId: 'session', userOrganizationId: 'membership', organizationId: 'org', storeId }))}.signature`;
    let calls = 0;
    const f = await loadRequest(async (config) => {
      if (config.url === '/v1/auth/refresh')
        return response(config, 200, {
          data: { auth: { access_token: jwt(null) } },
        });
      calls++;
      throw unauthorized(config);
    });
    f.token.value = jwt('store');
    await expect(f.request.post('/sale', {})).rejects.toMatchObject({
      code: 'AUTH_CONTEXT_CHANGED',
    });
    expect(f.token.value).toBe(jwt(null));
    expect(calls).toBe(1);
    expect(f.resync).toHaveBeenCalledTimes(1);
  });

  it('resyncs a 409 context selection without replaying the selection or logging out', async () => {
    let calls = 0;
    const f = await loadRequest(async (config) => {
      if (config.url === '/v1/auth/refresh')
        return response(config, 200, {
          data: { auth: { access_token: 'new-token' } },
        });
      calls++;
      throw new AxiosError(
        'State changed',
        undefined,
        config,
        undefined,
        response(config, 409, { error_code: 'AUTH_STATE_CHANGED' }),
      );
    });
    await expect(
      f.request.post('/v1/auth/select-context', {}),
    ).rejects.toMatchObject({ response: { status: 409 } });
    expect(f.token.value).toBe('new-token');
    expect(calls).toBe(1);
    expect(f.resync).toHaveBeenCalledTimes(1);
  });

  it.each(['/v1/auth/login', '/v1/auth/register'])(
    'waits for old refresh cookies before dispatching %s',
    async (url) => {
      let finish!: () => void;
      const calls: string[] = [];
      const f = await loadRequest(async (config) => {
        calls.push(config.url!);
        if (config.url === '/v1/auth/refresh') {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return response(config, 200, {
            data: { auth: { access_token: 'old-refresh' } },
          });
        }
        return response(config, 200, {
          data: { auth: { access_token: 'committed-auth-token' } },
        });
      });
      const refreshing = f
        .refreshAccessToken()
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      const login = f.request.post(url, {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      const before = [...calls];
      finish();
      await Promise.all([refreshing, login]);
      expect(before).toEqual(['/v1/auth/refresh']);
      expect(f.token.value).toBe('committed-auth-token');
      expect(f.token.generation).toBe(1);
    },
  );

  it('resynchronizes the cookie after selection invalidates an ongoing refresh', async () => {
    let finish!: () => void;
    let refreshCalls = 0;
    const sent: string[] = [];
    const f = await loadRequest(async (config) => {
      if (config.url === '/v1/auth/refresh') {
        refreshCalls++;
        if (refreshCalls === 1)
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return response(config, 200, {
          data: { auth: { access_token: `refreshed-${refreshCalls}` } },
        });
      }
      sent.push(String(config.headers.get('Authorization')));
      return response(config, 200, {
        data: { auth: { access_token: 'committed-auth-token' } },
      });
    });
    const refreshing = f.refreshAccessToken().catch((error: unknown) => error);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const selecting = f.request.post('/v1/auth/select-context', {});
    const selection = selecting.catch((error: unknown) => error);
    finish();
    await refreshing;
    await expect(selection).resolves.toHaveProperty('status', 200);
    expect(sent).toEqual(['Bearer refreshed-2']);
  });

  it('renews a token expiring within five seconds before the first protected dispatch', async () => {
    const old = `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 4, sub: 'user', sessionId: 'old' }))}.s`;
    const fresh = `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, sub: 'user', sessionId: 'new' }))}.s`;
    const calls: string[] = [];
    const f = await loadRequest(async (config) => {
      calls.push(config.url!);
      if (config.url === '/v1/auth/refresh')
        return response(config, 200, {
          data: { auth: { access_token: fresh } },
        });
      expect(config.headers.get('Authorization')).toBe(`Bearer ${fresh}`);
      return response(config, 200, {});
    });
    f.token.value = old;
    await f.request.get('/protected');
    expect(calls).toEqual(['/v1/auth/refresh', '/protected']);
  });

  it('permits proven legacy session-id rotations across multiple renewals for a late response', async () => {
    const jwt = (sessionId: string) =>
      `h.${btoa(JSON.stringify({ sub: 'user', sessionId, userOrganizationId: 'membership', organizationId: 'org', storeId: 'store' }))}.s`;
    let finish!: () => void;
    let rotations = 0;
    const f = await loadRequest(async (config) => {
      if (config.url === '/v1/auth/refresh')
        return response(config, 200, {
          data: { auth: { access_token: jwt(String(++rotations)) } },
        });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return response(config, 200, { data: 'same context' });
    });
    f.token.value = jwt('initial');
    const pending = f.request.get('/slow');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await f.refreshAccessToken();
    await f.refreshAccessToken();
    finish();
    await expect(pending).resolves.toHaveProperty('data.data', 'same context');
  });

  it('does not accept a same-token refresh result after an auth operation starts', async () => {
    let finish!: () => void;
    const f = await loadRequest(async (config) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return response(config, 200, {
        data: { auth: { access_token: 'new-token' } },
      });
    });
    const pending = f.refreshAccessToken();
    const checked = expect(pending).rejects.toMatchObject({
      code: 'AUTH_CONTEXT_CHANGED',
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    f.token.generation++;
    finish();
    await checked;
    expect(f.token.value).toBe('expired-token');
  });

  it('queues refresh started after login dispatch and captures the committed session', async () => {
    let finish!: () => void;
    const calls: string[] = [];
    const f = await loadRequest(async (config) => {
      calls.push(config.url!);
      if (config.url === '/v1/auth/login')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return response(config, 200, {
        data: {
          auth: {
            access_token:
              config.url === '/v1/auth/login'
                ? 'login-token'
                : 'renewed-login-token',
          },
        },
      });
    });
    const login = f.request.post('/v1/auth/login', {});
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const refreshing = f.refreshAccessToken();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = [...calls];
    finish();
    await Promise.all([login, refreshing]);
    expect(before).toEqual(['/v1/auth/login']);
    expect(f.token.value).toBe('renewed-login-token');
  });

  it('queues logout after an in-flight login so a late login cannot reinstall its cookie', async () => {
    let finish!: () => void;
    const calls: string[] = [];
    const f = await loadRequest(async (config) => {
      calls.push(config.url!);
      if (config.url === '/v1/auth/login')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return response(config, 200, {
        data: { auth: { access_token: 'late-login-token' } },
      });
    });
    const login = f.request
      .post('/v1/auth/login', {})
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    f.token.generation++;
    const logout = f.request.post('/v1/auth/logout', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = [...calls];
    finish();
    await Promise.all([login, logout]);
    expect(before).toEqual(['/v1/auth/login']);
    expect(calls).toEqual(['/v1/auth/login', '/v1/auth/logout']);
    expect(f.token.value).toBeNull();
  });

  it('does not overwrite a newer login with a late refresh response', async () => {
    let finish!: () => void;
    const { refreshAccessToken, token } = await loadRequest(async (config) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return response(config, 200, {
        data: { auth: { access_token: 'stale-refresh-token' } },
      });
    });
    const refreshing = refreshAccessToken();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    token.value = 'new-login-token';
    finish();
    await expect(refreshing).rejects.toMatchObject({
      code: 'AUTH_CONTEXT_CHANGED',
    });
    expect(token.value).toBe('new-login-token');
  });

  it('does not log out a newer login after an old refresh is rejected', async () => {
    let finish!: () => void;
    const { refreshAccessToken, token } = await loadRequest(async (config) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw unauthorized(config);
    });
    const refreshing = refreshAccessToken();
    const result = refreshing.catch((error: unknown) => error);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    token.value = 'new-login-token';
    finish();
    await result;
    expect(token.value).toBe('new-login-token');
  });

  it('reuses the rotated token for a late 401 instead of rotating the session again', async () => {
    let finish!: () => void;
    let refreshCalls = 0;
    const { request } = await loadRequest(async (config) => {
      if (config.url === '/v1/auth/refresh') {
        refreshCalls++;
        return response(config, 200, {
          data: { auth: { access_token: 'new-token' } },
        });
      }
      if (config.headers.get('Authorization') === 'Bearer new-token')
        return response(config, 200, {});
      if (config.url === '/slow')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      throw unauthorized(config);
    });
    const slow = request.get('/slow');
    await request.get('/fast');
    finish();
    await slow;
    expect(refreshCalls).toBe(1);
  });

  it('uses one refresh for parallel 401 responses and retries both requests with the new token', async () => {
    let refreshCalls = 0;
    const adapter = vi.fn(async (rawConfig: InternalAxiosRequestConfig) => {
      const config = {
        ...rawConfig,
        headers: AxiosHeaders.from(rawConfig.headers),
      };
      if (config.url === '/v1/auth/refresh') {
        refreshCalls += 1;
        return response(config, 200, {
          data: { auth: { access_token: 'new-token' } },
        });
      }
      if (config.headers.get('Authorization') !== 'Bearer new-token') {
        throw unauthorized(config);
      }
      return response(config, 200, { data: { ok: true } });
    });
    const { request, token } = await loadRequest(adapter);

    const results = await Promise.all([
      request.get('/protected-a'),
      request.get('/protected-b'),
    ]);

    expect(results.map(({ data }) => data)).toEqual([
      { data: { ok: true } },
      { data: { ok: true } },
    ]);
    expect(refreshCalls).toBe(1);
    expect(token.value).toBe('new-token');
  });

  it('does not refresh an authentication request', async () => {
    let refreshCalls = 0;
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      if (config.url === '/v1/auth/refresh') refreshCalls += 1;
      throw unauthorized(config);
    });
    const { request } = await loadRequest(adapter);

    await expect(request.post('/v1/auth/login', {})).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refreshCalls).toBe(0);
  });

  it('retries a protected request at most once', async () => {
    let protectedCalls = 0;
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      if (config.url === '/v1/auth/refresh') {
        return response(config, 200, {
          data: { auth: { access_token: 'new-token' } },
        });
      }
      protectedCalls += 1;
      throw unauthorized(config);
    });
    const { request, token } = await loadRequest(adapter);

    await expect(request.get('/protected')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(protectedCalls).toBe(2);
    expect(token.value).toBeNull();
  });

  it('clears the access token when refresh is rejected as unauthorized', async () => {
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      throw unauthorized(config);
    });
    const { request, token } = await loadRequest(adapter);

    await expect(request.get('/protected')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(token.value).toBeNull();
  });
});
