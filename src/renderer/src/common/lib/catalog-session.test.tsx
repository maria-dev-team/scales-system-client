import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  type CatalogRequest,
  type CatalogState,
  emptyCatalogState,
} from '../../../../shared/catalog';
import { markPendingStoreSelection } from '../../features/auth/stores/access-token.storage';
import { useAuthStore } from '../../features/auth/stores/auth-store';
import * as authRequests from '../api/request';
import { queryKeys } from '../constants/query-keys';
import { CatalogAuthBridge } from './catalog-session';

const claims = {
  sub: 'operator',
  userOrganizationId: 'membership',
  organizationId: 'organization',
  storeId: 'store',
};
const tokenFor = (values: object = claims): string =>
  `h.${btoa(JSON.stringify(values))}.s`;
const token = tokenFor();
let client: QueryClient;
let refreshRequired: () => void;
const request = vi.fn<(input: CatalogRequest) => Promise<CatalogState>>(
  async () => emptyCatalogState(),
);

beforeEach(() => {
  client = new QueryClient();
  request.mockReset();
  markPendingStoreSelection(null);
  useAuthStore.setState({
    accessToken: null,
    authGeneration: 0,
    isInitialized: true,
    isLoggingOut: false,
  });
  window.catalog = {
    request: request as never,
    onChange: () => () => {},
    onRefreshRequired: (listener) => {
      refreshRequired = listener;
      return () => {};
    },
  };
});
afterEach(() => {
  cleanup();
  client.clear();
  delete window.catalog;
  markPendingStoreSelection(null);
  vi.restoreAllMocks();
});

const renderBridge = () =>
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <CatalogAuthBridge />
      </QueryClientProvider>
    </StrictMode>,
  );

it('automatically connects a restored full context once without mounting the catalog page', async () => {
  useAuthStore.setState({ accessToken: token, isInitialized: false });
  renderBridge();
  expect(request).not.toHaveBeenCalled();
  await act(async () => useAuthStore.setState({ isInitialized: true }));
  expect(request.mock.calls).toEqual([
    [{ type: 'connect', accessToken: token }],
  ]);
});

it('does not repeat startup for StrictMode or unrelated auth state updates', async () => {
  useAuthStore.setState({ accessToken: token });
  renderBridge();
  await act(async () => useAuthStore.setState({ isInitializing: false }));
  expect(request.mock.calls).toEqual([
    [{ type: 'connect', accessToken: token }],
  ]);
});

it.each([
  null,
  'invalid',
  ...Object.keys(claims).map((key) => tokenFor({ ...claims, [key]: null })),
])('does not connect an offline or incomplete session (%s)', (accessToken) => {
  useAuthStore.setState({ accessToken });
  renderBridge();
  expect(request).not.toHaveBeenCalled();
});

it('waits for explicit store selection even if the organization response includes a primary store', async () => {
  useAuthStore.setState({ accessToken: tokenFor({ sub: claims.sub }) });
  renderBridge();
  const select = (storeSelected: boolean) =>
    client.getMutationCache().build(client, {
      mutationKey: queryKeys.auth.selectContext,
      mutationFn: async () => {
        useAuthStore.getState().beginAuthChange();
        useAuthStore.getState().commitAccessToken(token);
      },
      onSuccess: () => markPendingStoreSelection(storeSelected ? null : token),
    });
  await act(async () => select(false).execute(undefined));
  expect(request).not.toHaveBeenCalledWith({
    type: 'connect',
    accessToken: token,
  });
  await act(async () => select(true).execute(undefined));
  expect(request).toHaveBeenLastCalledWith({
    type: 'connect',
    accessToken: token,
  });
  expect(
    request.mock.calls.filter(([input]) => input.type === 'connect'),
  ).toHaveLength(1);
});

it('disconnects the old store before starting the newly selected store', async () => {
  useAuthStore.setState({ accessToken: token });
  renderBridge();
  const next = tokenFor({ ...claims, storeId: 'another-store' });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const selection = client.getMutationCache().build(client, {
    mutationKey: queryKeys.auth.selectContext,
    mutationFn: async () => {
      useAuthStore.getState().beginAuthChange();
      await pending;
      useAuthStore.getState().commitAccessToken(next);
    },
  });
  let selected!: Promise<void>;
  await act(async () => {
    selected = selection.execute(undefined);
  });
  expect(request).toHaveBeenLastCalledWith({ type: 'disconnect' });
  await act(async () => {
    finish();
    await selected;
  });
  expect(request.mock.calls).toEqual([
    [{ type: 'connect', accessToken: token }],
    [{ type: 'disconnect' }],
    [{ type: 'connect', accessToken: next }],
  ]);
});

it.each([token, tokenFor({ ...claims, exp: 1234567890 })])(
  'reconnects once after worker-requested refresh, including an unchanged token',
  async (renewed) => {
    useAuthStore.setState({ accessToken: token });
    vi.spyOn(authRequests, 'refreshAccessToken').mockImplementation(
      async () => {
        useAuthStore.getState().setAccessToken(renewed, true);
        return renewed;
      },
    );
    renderBridge();
    await act(async () => refreshRequired());
    expect(request.mock.calls).toEqual([
      [{ type: 'connect', accessToken: token }],
      [{ type: 'connect', accessToken: renewed }],
    ]);
  },
);

it('does not reconnect from a delayed refresh after logout', async () => {
  useAuthStore.setState({ accessToken: token });
  let finish!: (value: string) => void;
  vi.spyOn(authRequests, 'refreshAccessToken').mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  renderBridge();
  await act(async () => refreshRequired());
  await act(async () => useAuthStore.getState().clearAccessToken());
  await act(async () => finish(token));
  expect(request.mock.calls).toEqual([
    [{ type: 'connect', accessToken: token }],
    [{ type: 'disconnect' }],
  ]);
});

it('retries a failed initial connection when the network returns', async () => {
  useAuthStore.setState({ accessToken: token });
  request.mockRejectedValueOnce(new Error('Network unavailable'));
  renderBridge();
  await act(async () => {});
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(request.mock.calls).toEqual([
    [{ type: 'connect', accessToken: token }],
    [{ type: 'connect', accessToken: token }],
  ]);
});

it('does not reconnect an expired token while a worker refresh is pending', async () => {
  useAuthStore.setState({ accessToken: token });
  let finish!: (value: string) => void;
  vi.spyOn(authRequests, 'refreshAccessToken').mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  renderBridge();
  await act(async () => refreshRequired());
  await act(async () => useAuthStore.setState({ isInitializing: false }));
  expect(request.mock.calls).toEqual([
    [{ type: 'connect', accessToken: token }],
  ]);
  await act(async () => finish(token));
  expect(request).toHaveBeenCalledTimes(2);
});
