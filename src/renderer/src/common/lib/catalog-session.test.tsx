import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { emptyCatalogState } from '../../../../shared/catalog';
import { useAuthStore } from '../../features/auth/stores/auth-store';
import { CatalogAuthBridge, useCatalogSession } from './catalog-session';

function Session() {
  useCatalogSession();
  return null;
}
afterEach(() => {
  delete window.catalog;
  useAuthStore.setState({ accessToken: null, authGeneration: 0 });
});

it('hands off only the current token and revokes worker access when authentication changes', async () => {
  const request = vi.fn(async () => emptyCatalogState());
  window.catalog = {
    request: request as never,
    onChange: () => () => {},
    onRefreshRequired: () => () => {},
  };
  useAuthStore.setState({ accessToken: 'first', authGeneration: 0 });
  render(
    <>
      <CatalogAuthBridge />
      <Session />
    </>,
  );
  expect(request).toHaveBeenCalledWith({
    type: 'connect',
    accessToken: 'first',
  });
  await act(async () => useAuthStore.getState().beginAuthChange());
  expect(request).toHaveBeenLastCalledWith({ type: 'disconnect' });
  await act(async () => useAuthStore.setState({ accessToken: 'second' }));
  expect(request).toHaveBeenLastCalledWith({
    type: 'connect',
    accessToken: 'second',
  });
});

it('does not connect an offline session without a token', () => {
  const request = vi.fn();
  window.catalog = {
    request,
    onChange: () => () => {},
    onRefreshRequired: () => () => {},
  };
  render(<Session />);
  expect(request).not.toHaveBeenCalled();
});
