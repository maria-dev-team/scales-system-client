import { QueryClient } from '@tanstack/react-query';
import axios, {
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryKeys } from '../constants/query-keys';
import type {
  AuthContextResponse,
  OrganizationMembershipResponse,
} from './index';

const memberships: OrganizationMembershipResponse[] = [
  {
    membership_id: 'membership-1',
    organization: {
      address: 'Almaty',
      bin_iin: '123456789012',
      created_at: '2026-10-01T00:00:00.000Z',
      default_currency: 'KZT',
      deleted_at: null,
      id: 'organization-1',
      language: 'ru',
      legal_form: 'LLP',
      legal_name: 'Market LLP',
      name: 'Market',
      timezone: 'Asia/Almaty',
      trade_name: null,
      updated_at: '2026-10-01T00:00:00.000Z',
    },
    position: {
      created_at: '2026-10-01T00:00:00.000Z',
      deleted_at: null,
      id: 'position-1',
      is_system: false,
      name: 'Operator',
      organization_id: 'organization-1',
      permissions: ['product.read'],
      updated_at: '2026-10-01T00:00:00.000Z',
    },
    status: 'ACTIVE',
  },
  {
    membership_id: 'membership-2',
    organization: null,
    position: null,
    status: 'SUSPENDED',
  },
];

const context: AuthContextResponse = {
  isSystemPosition: false,
  organizationId: 'organization-1',
  permissions: ['product.read'],
  position: 'Operator',
  storeId: null,
  storeScope: {
    canAccessAll: false,
    primaryStoreId: 'store-1',
    storeIds: ['store-1'],
    stores: [{ address: null, id: 'store-1', name: 'Main store' }],
  },
  userOrganizationId: 'membership-1',
};

const originalAdapter = axios.defaults.adapter;

const setupApi = async (responses: Record<string, unknown>) => {
  const calls: InternalAxiosRequestConfig[] = [];
  axios.defaults.adapter = async (config): Promise<AxiosResponse> => {
    calls.push(config);
    return {
      config,
      data: responses[config.url!],
      headers: {},
      status: 200,
      statusText: 'OK',
    };
  };
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', 'http://localhost:4004');
  const api = await import('./index');
  const session = { token: 'initial-token' as string | null, generation: 0 };
  api.configureAccessTokenProvider({
    getAccessToken: () => session.token,
    getAuthGeneration: () => session.generation,
    beginAuthChange: () => {
      session.generation += 1;
    },
    setAccessToken: (token) => {
      session.token = token;
    },
    commitAccessToken: (token) => {
      session.token = token;
      session.generation += 1;
    },
    clearAccessToken: () => {
      session.token = null;
    },
  });
  return { api, calls, session };
};

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  vi.unstubAllEnvs();
});

describe('organization and store context endpoints', () => {
  it('loads the current user memberships without changing their snake_case fields', async () => {
    const { api, calls } = await setupApi({
      '/v1/organizations': { data: { organizations: memberships } },
    });
    const controller = new AbortController();

    await expect(api.getMyOrganizations(controller.signal)).resolves.toEqual(
      memberships,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'get',
      url: '/v1/organizations',
      withCredentials: true,
      signal: controller.signal,
    });
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer initial-token');
  });

  it('loads the authorized store scope without changing its camelCase fields', async () => {
    const { api, calls } = await setupApi({
      '/v1/auth/context': { data: { context } },
    });
    const controller = new AbortController();

    await expect(api.getAuthContext(controller.signal)).resolves.toEqual(
      context,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'get',
      url: '/v1/auth/context',
      withCredentials: true,
      signal: controller.signal,
    });
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer initial-token');
  });

  it.each([
    {
      name: 'an organization',
      storeId: undefined,
      payload: { user_organization_id: 'membership-1' },
    },
    {
      name: 'a store',
      storeId: 'store-1',
      payload: {
        user_organization_id: 'membership-1',
        store_id: 'store-1',
      },
    },
  ])(
    'selects $name using the membership ID and commits the returned token',
    async ({ storeId, payload }) => {
      const { api, calls, session } = await setupApi({
        '/v1/auth/select-context': {
          data: { auth: { access_token: 'selected-token' } },
        },
        '/v1/auth/context': { data: { context } },
      });

      await expect(
        api.selectContext(memberships[0]!.membership_id, storeId),
      ).resolves.toEqual({ access_token: 'selected-token' });
      expect(JSON.parse(calls[0]?.data as string)).toEqual(payload);
      expect(calls[0]).toMatchObject({
        method: 'post',
        url: '/v1/auth/select-context',
        withCredentials: true,
      });
      expect(session.token).toBe('selected-token');
      await api.getAuthContext();
      expect(calls[1]?.headers.get('Authorization')).toBe(
        'Bearer selected-token',
      );
    },
  );

  it('keeps membership and context caches separate across auth generations', () => {
    const cache = new QueryClient();
    cache.setQueryData(queryKeys.auth.organizations(1), memberships);
    cache.setQueryData(queryKeys.auth.context(1), context);

    expect(cache.getQueryData(queryKeys.auth.organizations(1))).toEqual(
      memberships,
    );
    expect(cache.getQueryData(queryKeys.auth.context(1))).toEqual(context);
    expect(cache.getQueryData(queryKeys.auth.organizations(2))).toBeUndefined();
    expect(cache.getQueryData(queryKeys.auth.context(2))).toBeUndefined();
    cache.clear();
  });
});
