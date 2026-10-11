import { useEffect } from 'react';

import { hasPendingStoreSelection } from '../../features/auth/stores/access-token.storage';
import { useAuthStore } from '../../features/auth/stores/auth-store';
import { refreshAccessToken } from '../api/request';

export function useCatalogSession(): void {
  const token = useAuthStore((state) => state.accessToken);
  useEffect(() => {
    if (!token || hasPendingStoreSelection(token)) return;
    // The worker verifies identity, store and permission independently.
    void window.catalog
      ?.request({ type: 'connect', accessToken: token })
      .catch(() => undefined);
  }, [token]);
}

export function CatalogAuthBridge(): null {
  useEffect(() => {
    const api = window.catalog;
    if (!api) return;
    const unsubscribe = useAuthStore.subscribe((state, previous) => {
      if (
        state.authGeneration !== previous.authGeneration ||
        (!state.accessToken && previous.accessToken)
      )
        void api.request({ type: 'disconnect' }).catch(() => undefined);
    });
    let refreshing: Promise<void> | null = null;
    const stopRefresh = api.onRefreshRequired(() => {
      if (refreshing) return;
      const generation = useAuthStore.getState().authGeneration;
      refreshing = refreshAccessToken()
        .then(async (token) => {
          if (
            useAuthStore.getState().authGeneration === generation &&
            !hasPendingStoreSelection(token)
          )
            await api.request({ type: 'connect', accessToken: token });
        })
        .catch(() => undefined)
        .finally(() => {
          refreshing = null;
        });
    });
    return () => {
      unsubscribe();
      stopRefresh();
    };
  }, []);
  return null;
}
