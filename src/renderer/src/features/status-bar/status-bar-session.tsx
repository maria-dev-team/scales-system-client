import { useIsMutating, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getAuthContext,
  getCurrentUser,
  getMyOrganizations,
} from '@renderer/common/api';
import { queryKeys } from '@renderer/common/constants/query-keys';
import { getHttpErrorMessage } from '@renderer/common/helpers/http-error.helper';

import { useAuthStore } from '../auth';
import {
  EMPTY_STATUS_BAR,
  type StatusBarData,
  useSetStatusBar,
} from './status-bar-context';

export function StatusBarSession() {
  const publish = useSetStatusBar();
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const generation = useAuthStore((state) => state.authGeneration);
  const isLoggingOut = useAuthStore((state) => state.isLoggingOut);
  const logout = useAuthStore((state) => state.logout);
  const selectingContext =
    useIsMutating({ mutationKey: queryKeys.auth.selectContext }) > 0;
  const enabled = Boolean(accessToken) && !isLoggingOut && !selectingContext;
  const [logoutError, setLogoutError] = useState<{
    generation: number;
    message: string;
  } | null>(null);
  const user = useQuery({
    queryKey: queryKeys.auth.currentUser(generation),
    queryFn: getCurrentUser,
    enabled,
  });
  const context = useQuery({
    queryKey: queryKeys.auth.context(generation),
    queryFn: ({ signal }) => getAuthContext(signal),
    enabled,
  });
  const organizations = useQuery({
    queryKey: queryKeys.auth.organizations(generation),
    queryFn: ({ signal }) => getMyOrganizations(signal),
    enabled,
  });

  const handleLogout = useCallback((): void => {
    if (useAuthStore.getState().isLoggingOut) return;
    setLogoutError(null);
    const pending = logout();
    const logoutGeneration = useAuthStore.getState().authGeneration;
    void pending.then(
      () => queryClient.clear(),
      (error: unknown) => {
        if (useAuthStore.getState().authGeneration === logoutGeneration)
          setLogoutError({
            generation: logoutGeneration,
            message: getHttpErrorMessage(error),
          });
      },
    );
  }, [logout, queryClient]);

  const value = useMemo<StatusBarData>(() => {
    const membership = enabled
      ? organizations.data?.find(
          (entry) =>
            entry.status === 'ACTIVE' &&
            entry.membership_id === context.data?.userOrganizationId &&
            entry.organization?.id === context.data?.organizationId,
        )
      : undefined;
    const store = membership
      ? context.data?.storeScope.stores.find(
          (entry) => entry.id === context.data?.storeId,
        )
      : undefined;
    return {
      contextName: membership
        ? [membership.organization?.name, store?.name]
            .filter(Boolean)
            .join(' · ') || null
        : null,
      user:
        enabled && user.data
          ? {
              fullName:
                [user.data.first_name, user.data.last_name]
                  .filter(Boolean)
                  .join(' ') ||
                user.data.email ||
                'Пользователь',
              position: membership
                ? (context.data?.position ??
                  membership.position?.name ??
                  'Сотрудник')
                : 'Сотрудник',
            }
          : null,
      isAuthenticated: Boolean(accessToken),
      isLoggingOut,
      logoutError:
        accessToken && logoutError?.generation === generation
          ? logoutError.message
          : null,
      logout: accessToken ? handleLogout : null,
    };
  }, [
    enabled,
    organizations.data,
    context.data,
    user.data,
    accessToken,
    isLoggingOut,
    logoutError,
    generation,
    handleLogout,
  ]);

  useEffect(() => publish(value), [publish, value]);
  useEffect(() => () => publish(EMPTY_STATUS_BAR), [publish]);
  return null;
}
