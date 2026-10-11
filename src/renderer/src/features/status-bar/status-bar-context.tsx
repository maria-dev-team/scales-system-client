import { type ReactNode, createContext, useContext, useState } from 'react';

export type StatusBarData = {
  contextName: string | null;
  user: { fullName: string; position: string } | null;
  isAuthenticated: boolean;
  isLoggingOut: boolean;
  logoutError: string | null;
  logout: (() => void) | null;
};

// eslint-disable-next-line react-refresh/only-export-components
export const EMPTY_STATUS_BAR: StatusBarData = {
  contextName: null,
  user: null,
  isAuthenticated: false,
  isLoggingOut: false,
  logoutError: null,
  logout: null,
};

const StatusBarContext = createContext<StatusBarData>(EMPTY_STATUS_BAR);
const SetStatusBarContext = createContext<(value: StatusBarData) => void>(
  () => undefined,
);

export function StatusBarProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState(EMPTY_STATUS_BAR);
  return (
    <SetStatusBarContext value={setValue}>
      <StatusBarContext value={value}>{children}</StatusBarContext>
    </SetStatusBarContext>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useStatusBar = (): StatusBarData => useContext(StatusBarContext);
// eslint-disable-next-line react-refresh/only-export-components
export const useSetStatusBar = (): ((value: StatusBarData) => void) =>
  useContext(SetStatusBarContext);
