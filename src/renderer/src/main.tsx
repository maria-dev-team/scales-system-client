import { createRoot } from 'react-dom/client';

import { AuthShell } from './common/components/auth-shell';
import './common/styles/base.css';

const root = createRoot(document.getElementById('root')!);

if (!import.meta.env.VITE_API_URL?.trim()) {
  root.render(
    <AuthShell
      title="DukenAI Scales"
      description="Требуется настройка приложения"
    >
      <p className="text-sm leading-6 text-muted-foreground" role="alert">
        Адрес сервера не настроен. Обратитесь к администратору.
      </p>
    </AuthShell>,
  );
} else {
  void import('./bootstrap')
    .then(({ bootstrap }) => bootstrap(root))
    .catch(() => {
      root.render(
        <AuthShell
          title="DukenAI Scales"
          description="Не удалось запустить приложение"
        >
          <p className="text-sm leading-6 text-muted-foreground" role="alert">
            Проверьте настройки сервера и перезапустите приложение.
          </p>
        </AuthShell>,
      );
    });
}
