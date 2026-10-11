import { LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { CatalogState } from '../../shared/catalog';
import { Button } from './common/components/ui/button';
import { decodeAccessToken } from './common/helpers/access-token';
import { getHttpErrorMessage } from './common/helpers/http-error.helper';
import {
  AuthShell,
  LoginView,
  SignedInView,
  useAuthStore,
} from './features/auth';
import { CatalogView } from './features/catalog';

export default function App() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const initialize = useAuthStore((state) => state.initialize);
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const [initializationError, setInitializationError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [localState, setLocalState] = useState<CatalogState | null>(null);

  useEffect(() => {
    const api = window.catalog;
    if (!api) return;
    let active = true;
    const update = (): void => {
      void api
        .request({ type: 'state' })
        .then((state) => {
          if (active) setLocalState(state);
        })
        .catch(() => undefined);
    };
    update();
    const unsubscribe = api.onChange(update);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (isInitialized) return;
    let active = true;
    void initialize().catch((error: unknown) => {
      if (active) setInitializationError(error);
    });
    return () => {
      active = false;
    };
  }, [attempt, initialize, isInitialized]);

  const cachedScope = localState?.scope;
  const claims = decodeAccessToken(accessToken);
  const tokenMatchesCachedScope =
    cachedScope &&
    claims?.sub === cachedScope.userId &&
    claims?.userOrganizationId === cachedScope.membershipId &&
    claims?.organizationId === cachedScope.organizationId &&
    claims?.storeId === cachedScope.storeId;

  if (
    (!accessToken || tokenMatchesCachedScope) &&
    cachedScope &&
    localState.access === 'offline'
  ) {
    return (
      <CatalogView
        storeName={cachedScope.storeName}
        footer={
          <Button
            variant="ghost"
            onClick={() => {
              void window.catalog?.request({ type: 'disconnect' }).then(() => {
                setLocalState(null);
                useAuthStore.getState().clearAccessToken();
              });
            }}
          >
            Выйти из локального каталога
          </Button>
        }
      />
    );
  }

  if (!isInitialized) {
    return (
      <AuthShell title="DukenAI Scales" description="Восстановление входа">
        {initializationError ? (
          <div className="space-y-5">
            <p
              className="text-center text-sm leading-6 text-destructive"
              role="alert"
            >
              {getHttpErrorMessage(initializationError)}
            </p>
            <Button
              className="w-full"
              onClick={() => {
                setInitializationError(null);
                setAttempt((current) => current + 1);
              }}
            >
              Повторить
            </Button>
          </div>
        ) : (
          <p
            className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
            Проверяем учётную запись…
          </p>
        )}
      </AuthShell>
    );
  }

  return accessToken ? <SignedInView /> : <LoginView />;
}
