import { LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from './common/components/ui/button';
import { getHttpErrorMessage } from './common/helpers/http-error.helper';
import {
  AuthShell,
  LoginView,
  SignedInView,
  useAuthStore,
} from './features/auth';

export default function App() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const initialize = useAuthStore((state) => state.initialize);
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const [initializationError, setInitializationError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

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
