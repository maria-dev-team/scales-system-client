import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, LogOut } from 'lucide-react';
import { useState } from 'react';

import { getCurrentUser } from '@renderer/common/api';
import { AuthShell } from '@renderer/common/components/auth-shell';
import { Button } from '@renderer/common/components/ui/button';
import { queryKeys } from '@renderer/common/constants/query-keys';
import { getHttpErrorMessage } from '@renderer/common/helpers/http-error.helper';

import { useAuthStore } from './stores/auth-store';

export function SignedInView() {
  const queryClient = useQueryClient();
  const authGeneration = useAuthStore((state) => state.authGeneration);
  const isLoggingOut = useAuthStore((state) => state.isLoggingOut);
  const logout = useAuthStore((state) => state.logout);
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const user = useQuery({
    queryKey: queryKeys.auth.currentUser(authGeneration),
    queryFn: getCurrentUser,
    enabled: !isLoggingOut,
  });

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

  const displayName = user.data
    ? [user.data.first_name, user.data.last_name].filter(Boolean).join(' ') ||
      'Вы вошли в систему'
    : '';

  return (
    <AuthShell title="DukenAI Scales" description="Учётная запись">
      <div className="space-y-6 text-center">
        {user.isPending ? (
          <p
            className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
            Загрузка учётной записи…
          </p>
        ) : null}
        {user.data ? (
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">{displayName}</h2>
            <p className="break-all text-sm text-muted-foreground">
              {user.data.email || user.data.phone}
            </p>
            <p className="pt-2 text-sm text-muted-foreground">
              Вход выполнен успешно.
            </p>
          </div>
        ) : null}
        {user.isError ? (
          <div className="space-y-3">
            <p className="text-sm leading-6 text-destructive" role="alert">
              {getHttpErrorMessage(user.error)}
            </p>
            <Button
              disabled={user.isFetching || isLoggingOut}
              onClick={() => void user.refetch()}
              variant="ghost"
            >
              Повторить
            </Button>
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
        >
          {isLoggingOut ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" />
          ) : (
            <LogOut aria-hidden="true" />
          )}
          Выйти
        </Button>
      </div>
    </AuthShell>
  );
}
