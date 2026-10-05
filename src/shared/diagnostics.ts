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

export interface TestProduct {
  name: string;
  lfCode: string;
  code: string;
  pricePerKg: string;
  unit: 'kg';
}

export const TEST_PRODUCT: TestProduct = {
  name: 'TEST APPLE',
  lfCode: '900001',
  code: '0000900001',
  pricePerKg: '12.34',
  unit: 'kg',
};

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

export interface DiagnosticStep {
  id: string;
  title: string;
  status: CheckStatus | 'pending' | 'running';
  summary: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  details?: unknown;
  commands?: CommandResult[];
}

export interface DiagnosticRun {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'cancelled';
  profile: DiagnosticProfile | null;
  testProduct: TestProduct;
  steps: DiagnosticStep[];
  reportDirectory: string;
  persistenceError: string | null;
  protocolStatus: 'unverified' | 'write-acknowledged';
  transferTest?: TransferTestOptions;
  printObservation?: PrintObservation;
}

export interface TransferTestOptions {
  priceDecimals: 2 | 3;
}

export interface PrintTestInput {
  runId: string;
  outcome: 'printed-correctly' | 'wrong-data' | 'not-printed';
  note: string;
}

export interface PrintObservation extends PrintTestInput {
  recordedAt: string;
  source: 'operator';
}

export interface DiagnosticState {
  run: DiagnosticRun | null;
  interfaces: NetworkAdapter[];
  profile: DiagnosticProfile | null;
  testProduct: TestProduct;
  profileError: string | null;
}

export interface DiagnosticsApi {
  getState(): Promise<DiagnosticState>;
  saveProfile(profile: DiagnosticProfile): Promise<DiagnosticState>;
  rerun(): Promise<DiagnosticState>;
  cancel(): Promise<DiagnosticState>;
  exportReport(): Promise<{ canceled: boolean; path?: string }>;
  startTransferTest(options: TransferTestOptions): Promise<DiagnosticState>;
  recordPrintResult(input: PrintTestInput): Promise<DiagnosticState>;
}
