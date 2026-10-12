import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { hasPendingStoreSelection } from '../../features/auth/stores/access-token.storage';
import { useAuthStore } from '../../features/auth/stores/auth-store';
import { refreshAccessToken } from '../api/request';
import { queryKeys } from '../constants/query-keys';
import { decodeAccessToken } from '../helpers/access-token';

export function CatalogAuthBridge(): null {
  const queryClient = useQueryClient();
  const lastConnection = useRef<{
    token: string;
    generation: number;
  } | null>(null);
  useEffect(() => {
    const api = window.catalog;
    if (!api) return;
    let active = true;
    let refreshing: { generation: number } | null = null;
    const connectCurrent = (): void => {
      const state = useAuthStore.getState();
      const token = state.accessToken;
      const claims = decodeAccessToken(token);
      if (
        !active ||
        !state.isInitialized ||
        state.isLoggingOut ||
        refreshing?.generation === state.authGeneration ||
        queryClient.isMutating({ mutationKey: queryKeys.auth.selectContext }) ||
        !token ||
        hasPendingStoreSelection(token) ||
        ![
          claims?.sub,
          claims?.userOrganizationId,
          claims?.organizationId,
          claims?.storeId,
        ].every((value) => typeof value === 'string' && value.trim())
      )
        return;
      if (
        lastConnection.current?.token === token &&
        lastConnection.current.generation === state.authGeneration
      )
        return;
      const connection = { token, generation: state.authGeneration };
      lastConnection.current = connection;
      // Claims only determine readiness. The worker verifies scope/permissions
      // against the server and starts synchronization after a successful connect.
      void api.request({ type: 'connect', accessToken: token }).catch(() => {
        if (lastConnection.current === connection)
          lastConnection.current = null;
      });
    };
    const unsubscribe = useAuthStore.subscribe((state, previous) => {
      if (
        state.authGeneration !== previous.authGeneration ||
        (!state.accessToken && previous.accessToken)
      ) {
        lastConnection.current = null;
        void api.request({ type: 'disconnect' }).catch(() => undefined);
        // beginAuthChange revokes the old context before a new token arrives.
        if (state.accessToken === previous.accessToken) return;
      }
      connectCurrent();
    });
    // onSuccess records the pending-store marker before the mutation settles.
    // This also handles choosing the primary store when the token stays identical.
    const stopSelection = queryClient
      .getMutationCache()
      .subscribe(connectCurrent);
    const stopRefresh = api.onRefreshRequired(() => {
      if (refreshing) return;
      const generation = useAuthStore.getState().authGeneration;
      const refresh = { generation };
      refreshing = refresh;
      lastConnection.current = null;
      void refreshAccessToken()
        .then(() => {
          refreshing = null;
          if (useAuthStore.getState().authGeneration === generation)
            connectCurrent();
        })
        .catch(() => undefined)
        .finally(() => {
          if (refreshing === refresh) refreshing = null;
        });
    });
    window.addEventListener('online', connectCurrent);
    connectCurrent();
    return () => {
      active = false;
      unsubscribe();
      stopSelection();
      stopRefresh();
      window.removeEventListener('online', connectCurrent);
    };
  }, [queryClient]);
  return null;
}
