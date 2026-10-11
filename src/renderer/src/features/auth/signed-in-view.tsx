import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { LoaderCircle, LogOut } from 'lucide-react';
import { useState } from 'react';

import {
  getAuthContext,
  getCurrentUser,
  getMyOrganizations,
  selectContext,
} from '@renderer/common/api';
import { Button } from '@renderer/common/components/ui/button';
import { queryKeys } from '@renderer/common/constants/query-keys';
import { getHttpErrorMessage } from '@renderer/common/helpers/http-error.helper';
import { CatalogView } from '@renderer/features/catalog';

import { OrganizationSelectionView } from './organization-selection-view';
import { StoreSelectionView } from './store-selection-view';
import {
  hasPendingStoreSelection,
  markPendingStoreSelection,
} from './stores/access-token.storage';
import { useAuthStore } from './stores/auth-store';

type Selection = { membershipId: string; storeId?: string };
type Step = 'current' | 'organizations' | 'stores';

export function SignedInView() {
  const queryClient = useQueryClient();
  const authGeneration = useAuthStore((state) => state.authGeneration);
  const isLoggingOut = useAuthStore((state) => state.isLoggingOut);
  const logout = useAuthStore((state) => state.logout);
  const [step, setStep] = useState<Step>('current');
  const [logoutError, setLogoutError] = useState<unknown>(null);
  // Keep queries paused until the context mutation finishes, including
  // after this view mounts again.
  const isSelectingContext =
    useIsMutating({ mutationKey: queryKeys.auth.selectContext }) > 0;
  const selection = useMutation({
    mutationKey: queryKeys.auth.selectContext,
    mutationFn: ({ membershipId, storeId }: Selection) =>
      selectContext(membershipId, storeId),
    onSuccess: (_auth, variables) => {
      // Selecting a membership may also pick the primary store on the server.
      // Still ask the operator to explicitly choose the store for the scales.
      markPendingStoreSelection(variables.storeId ? null : _auth.access_token);
      setStep(variables.storeId ? 'current' : 'stores');
      void queryClient.invalidateQueries({
        queryKey: queryKeys.auth.context(
          useAuthStore.getState().authGeneration,
        ),
        refetchType: 'none',
      });
    },
  });
  const disabled = isLoggingOut || isSelectingContext;
  const context = useQuery({
    queryKey: queryKeys.auth.context(authGeneration),
    queryFn: ({ signal }) => getAuthContext(signal),
    enabled: !disabled,
    placeholderData: (previous) => (isSelectingContext ? previous : undefined),
  });
  const organizations = useQuery({
    queryKey: queryKeys.auth.organizations(authGeneration),
    queryFn: ({ signal }) => getMyOrganizations(signal),
    enabled: !disabled,
    placeholderData: (previous) => (isSelectingContext ? previous : undefined),
  });
  const user = useQuery({
    queryKey: queryKeys.auth.currentUser(authGeneration),
    queryFn: getCurrentUser,
    enabled: !disabled,
  });

  const retry = (): void => {
    selection.reset();
    void context.refetch();
    void organizations.refetch();
    void user.refetch();
  };
  const changeStep = (nextStep: Step): void => {
    selection.reset();
    setStep(nextStep);
  };
  const handleLogout = async (): Promise<void> => {
    if (isLoggingOut) return;
    setLogoutError(null);
    try {
      await logout();
      queryClient.clear();
    } catch (error) {
      setLogoutError(error);
    }
  };

  const memberships = organizations.data ?? [];
  const membership = memberships.find(
    (entry) =>
      entry.membership_id === context.data?.userOrganizationId &&
      entry.status === 'ACTIVE' &&
      entry.organization?.id === context.data?.organizationId,
  );
  const stores = context.data?.storeScope.stores ?? [];
  const store = stores.find((entry) => entry.id === context.data?.storeId);
  const isLoading =
    !selection.isPending &&
    (isSelectingContext || context.isPending || organizations.isPending);
  const error =
    selection.error ?? context.error ?? organizations.error ?? user.error;
  const displayName = user.data
    ? [user.data.first_name, user.data.last_name].filter(Boolean).join(' ') ||
      'Учётная запись'
    : '';
  const footer = (
    <div className="mt-6 space-y-4 border-t border-border pt-5 text-center">
      {user.data ? (
        <div className="space-y-1">
          <p className="break-words text-sm font-medium">{displayName}</p>
          <p className="break-all text-xs text-muted-foreground">
            {user.data.email || user.data.phone}
          </p>
        </div>
      ) : null}
      {logoutError ? (
        <p className="text-sm leading-6 text-destructive" role="alert">
          {getHttpErrorMessage(logoutError)}
        </p>
      ) : null}
      <Button
        className="w-full"
        disabled={isLoggingOut}
        onClick={() => void handleLogout()}
        variant="ghost"
      >
        {isLoggingOut ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" />
        ) : (
          <LogOut aria-hidden="true" />
        )}
        Выйти
      </Button>
    </div>
  );

  if (step === 'organizations' || !membership) {
    return (
      <OrganizationSelectionView
        memberships={memberships}
        isLoading={isLoading}
        error={error}
        pendingId={
          selection.isPending ? selection.variables.membershipId : null
        }
        disabled={disabled}
        onSelect={(membershipId) => selection.mutate({ membershipId })}
        onRetry={retry}
        footer={footer}
      />
    );
  }

  if (
    step === 'stores' ||
    hasPendingStoreSelection(useAuthStore.getState().accessToken) ||
    !store ||
    isLoading ||
    error
  ) {
    return (
      <StoreSelectionView
        stores={stores}
        organizationName={membership.organization?.name}
        isLoading={isLoading}
        error={error}
        pendingId={
          selection.isPending ? (selection.variables.storeId ?? null) : null
        }
        disabled={disabled}
        onSelect={(storeId) =>
          selection.mutate({ membershipId: membership.membership_id, storeId })
        }
        onRetry={retry}
        onBack={() => changeStep('organizations')}
        footer={footer}
      />
    );
  }

  return (
    <CatalogView
      key={`${membership.membership_id}:${store.id}`}
      organizationName={membership.organization?.name}
      storeName={store.name}
      onChangeStore={() => changeStep('stores')}
      onChangeOrganization={() => changeStep('organizations')}
      disabled={disabled}
    />
  );
}
