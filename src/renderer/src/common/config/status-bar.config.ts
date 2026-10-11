export type StatusBarItem =
  'context' | 'user' | 'serverStatus' | 'clock' | 'logout' | 'minimize';

export const statusBarConfig = {
  healthCheckIntervalMs: 30_000,
  healthCheckTimeoutMs: 3_000,
  leftItems: ['context'],
  rightItems: ['user', 'serverStatus', 'clock', 'logout', 'minimize'],
} as const satisfies {
  healthCheckIntervalMs: number;
  healthCheckTimeoutMs: number;
  leftItems: readonly StatusBarItem[];
  rightItems: readonly StatusBarItem[];
};
