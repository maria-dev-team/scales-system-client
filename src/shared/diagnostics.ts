export interface DiagnosticProfile {
  scaleIp: string;
  port: number;
  localAddress: string;
}

export interface NetworkAdapter {
  name: string;
  address: string;
  netmask: string;
  mac: string;
}

export interface CommandResult {
  executable: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBase64: string;
  stderrBase64: string;
  encoding: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
  truncated?: boolean;
}

export type CheckStatus =
  'passed' | 'failed' | 'warning' | 'skipped' | 'cancelled';

export interface CheckResult {
  status: CheckStatus;
  summary: string;
  details?: unknown;
  commands?: CommandResult[];
}

export interface TransferTestOptions {
  priceDecimals: 2 | 3;
}
