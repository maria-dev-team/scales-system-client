import {
  Clock,
  LoaderCircle,
  LogOut,
  Minus,
  Wifi,
  WifiOff,
} from 'lucide-react';

import { Button } from '@renderer/common/components/ui/button';
import {
  type StatusBarItem,
  statusBarConfig,
} from '@renderer/common/config/status-bar.config';

import { version } from '../../../../../package.json';
import { useStatusBar } from './status-bar-context';
import { useApiHealth } from './use-api-health';
import { useMinuteClock } from './use-minute-clock';

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
});
const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

export function StatusBar() {
  const now = useMinuteClock();
  const account = useStatusBar();
  const health = useApiHealth();
  const renderItem = (item: StatusBarItem) => {
    switch (item) {
      case 'context':
        return (
          <div className="flex min-w-0 items-center gap-3" key={item}>
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary font-extrabold text-primary-foreground shadow-sm shadow-primary/20"
            >
              D
            </span>
            <span
              className="hidden truncate text-sm font-semibold text-foreground sm:inline"
              title={account.contextName ?? 'DukenAI Scales'}
            >
              {account.contextName ?? 'DukenAI Scales'}
            </span>
            <span className="inline-flex shrink-0 items-center rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              v{version}
            </span>
          </div>
        );
      case 'user': {
        if (!account.isAuthenticated || !account.user) return null;
        const initials = account.user.fullName
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0])
          .join('')
          .toUpperCase();
        return (
          <div className="flex min-w-0 items-center gap-2.5" key={item}>
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground"
            >
              {initials}
            </span>
            <span className="min-w-0 max-w-52 leading-tight">
              <span className="block truncate text-sm font-semibold text-foreground">
                {account.user.fullName}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {account.user.position}
              </span>
            </span>
          </div>
        );
      }
      case 'serverStatus': {
        const label =
          health === 'checking'
            ? 'Проверка'
            : health === 'unconfigured'
              ? 'Сервер не настроен'
              : health === 'offline'
                ? 'Нет связи с сервером'
                : 'Сервер доступен';
        const color =
          health === 'online'
            ? 'text-success'
            : health === 'offline'
              ? 'text-destructive'
              : 'text-muted-foreground';
        return (
          <span
            aria-label={label}
            title={label}
            className={`flex items-center gap-2 text-sm font-medium ${color}`}
            key={item}
            role="status"
          >
            {health === 'checking' ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            ) : health === 'online' ? (
              <Wifi aria-hidden="true" className="size-4" />
            ) : (
              <WifiOff aria-hidden="true" className="size-4" />
            )}
            <span className="hidden lg:inline">{label}</span>
          </span>
        );
      }
      case 'clock':
        return (
          <time
            aria-label="Текущее время"
            className="flex items-center gap-2 text-sm font-medium tabular-nums text-foreground"
            dateTime={now.toISOString()}
            key={item}
          >
            <Clock
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
            <span className="hidden md:inline">
              {dateFormatter.format(now)}
            </span>
            <span>{timeFormatter.format(now)}</span>
          </time>
        );
      case 'logout':
        if (!account.isAuthenticated || !account.logout) return null;
        return (
          <Button
            aria-label="Выйти"
            title="Выйти"
            className="min-h-12 min-w-12 px-3"
            disabled={account.isLoggingOut}
            key={item}
            onClick={account.logout}
            type="button"
            variant="ghost"
          >
            {account.isLoggingOut ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" />
            ) : (
              <LogOut aria-hidden="true" />
            )}
            <span className="sr-only">Выйти</span>
          </Button>
        );
      case 'minimize':
        if (!window.windowControls) return null;
        return (
          <Button
            aria-label="Свернуть приложение"
            className="min-h-12 min-w-12 px-3"
            key={item}
            onClick={() => window.windowControls?.minimize()}
            title="Свернуть"
            type="button"
            variant="ghost"
          >
            <Minus aria-hidden="true" />
            <span className="sr-only">Свернуть приложение</span>
          </Button>
        );
    }
  };
  return (
    <>
      <header
        aria-label="Статус приложения"
        className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-card px-4 sm:px-5"
      >
        <div className="flex min-w-0 items-center">
          {statusBarConfig.leftItems.map(renderItem)}
        </div>
        <div className="flex min-w-0 items-center justify-end gap-3 sm:gap-4">
          {statusBarConfig.rightItems.map(renderItem)}
        </div>
      </header>
      {account.logoutError ? (
        <p
          role="alert"
          className="border-b bg-destructive/10 px-5 py-3 text-sm text-destructive"
        >
          {account.logoutError}
        </p>
      ) : null}
    </>
  );
}
