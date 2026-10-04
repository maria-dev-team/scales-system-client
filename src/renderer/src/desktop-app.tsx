import { Scale } from 'lucide-react';
import { Component, Suspense, lazy, useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from './common/components/ui/button';
import { DiagnosticsView } from './features/diagnostics';

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
          Не удалось открыть Maria. Проверьте настройки сервера. Диагностика
          весов доступна в соседнем разделе.
        </p>
      );
    }
    return this.props.children;
  }
}

export default function DesktopApp() {
  const [section, setSection] = useState<'diagnostics' | 'maria'>(
    'diagnostics',
  );
  return (
    <>
      <header className="border-b bg-card px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Scale aria-hidden="true" className="size-6" />
            </span>
            <div>
              <p className="font-semibold tracking-tight">DukenAI Scales</p>
              <p className="text-xs text-muted-foreground">
                RLS1100 · Лаборатория подключения
              </p>
            </div>
          </div>
          <nav aria-label="Разделы приложения" className="flex gap-2">
            <Button
              variant={section === 'diagnostics' ? 'default' : 'ghost'}
              aria-current={section === 'diagnostics' ? 'page' : undefined}
              onClick={() => setSection('diagnostics')}
            >
              Диагностика
            </Button>
            <Button
              variant={section === 'maria' ? 'default' : 'ghost'}
              aria-current={section === 'maria' ? 'page' : undefined}
              onClick={() => setSection('maria')}
            >
              Maria
            </Button>
          </nav>
        </div>
      </header>
      {section === 'diagnostics' ? (
        <DiagnosticsView />
      ) : !import.meta.env.VITE_API_URL?.trim() ? (
        <main className="mx-auto max-w-xl p-8">
          <h1 className="mb-3 text-xl font-semibold">Вход в Maria</h1>
          <p role="alert">
            Адрес сервера не настроен. Обратитесь к администратору. Диагностика
            весов работает без сервера.
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
    </>
  );
}
