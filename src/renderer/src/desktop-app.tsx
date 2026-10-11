import { Component, Suspense, lazy } from 'react';
import type { ReactNode } from 'react';

import { Toaster } from '@renderer/common/components/ui/sonner';

import { StatusBar, StatusBarProvider } from './features/status-bar';

const MariaApp = lazy(() => import('./bootstrap'));

class MariaErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="mx-auto max-w-xl p-8 text-destructive" role="alert">
          Не удалось открыть Maria. Проверьте настройки сервера.
        </p>
      );
    }
    return this.props.children;
  }
}

export default function DesktopApp() {
  return (
    <StatusBarProvider>
      <Toaster />
      <div className="flex h-svh flex-col overflow-hidden">
        <div className="shrink-0">
          <StatusBar />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!import.meta.env.VITE_API_URL?.trim() ? (
            <main className="mx-auto max-w-xl p-8">
              <h1 className="mb-3 text-xl font-semibold">Вход в Maria</h1>
              <p role="alert">
                Адрес сервера не настроен. Обратитесь к администратору.
              </p>
            </main>
          ) : (
            <MariaErrorBoundary>
              <Suspense
                fallback={
                  <p role="status" className="p-8 text-center">
                    Открываем Maria…
                  </p>
                }
              >
                <MariaApp />
              </Suspense>
            </MariaErrorBoundary>
          )}
        </div>
      </div>
    </StatusBarProvider>
  );
}
