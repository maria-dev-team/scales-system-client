import { spawn } from 'node:child_process';

import type { CommandResult } from '../../shared/diagnostics';

interface CommandOptions {
  timeoutMs?: number;
  encoding?: string;
  maxBytes?: number;
}

// Only main-process probes call this runner. It is never exposed over IPC.
export function runCommand(
  executable: string,
  args: string[],
  signal: AbortSignal,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const encoding = options.encoding ?? 'utf-8';
  const limit = options.maxBytes ?? 1024 * 1024;
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = signal.aborted;
    let error: string | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;

    const finish = (
      exitCode: number | null,
      exitSignal: string | null,
    ): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (stop) signal.removeEventListener('abort', stop);
      const stdoutBytes = Buffer.concat(stdout);
      const stderrBytes = Buffer.concat(stderr);
      let decoder: TextDecoder;
      let usedEncoding = encoding;
      try {
        decoder = new TextDecoder(encoding);
      } catch {
        decoder = new TextDecoder('utf-8');
        usedEncoding = `${encoding}; unsupported, UTF-8 fallback (see original bytes)`;
      }
      const finishedAt = new Date().toISOString();
      resolve({
        executable,
        args,
        startedAt,
        finishedAt,
        durationMs: Date.now() - started,
        stdout: decoder.decode(stdoutBytes),
        stderr: decoder.decode(stderrBytes),
        stdoutBase64: stdoutBytes.toString('base64'),
        stderrBase64: stderrBytes.toString('base64'),
        encoding: usedEncoding,
        exitCode,
        signal: exitSignal,
        timedOut,
        cancelled,
        ...(error ? { error } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
    };
    if (cancelled) {
      finish(null, null);
      return;
    }

    try {
      const child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
      child.stdout.on('data', (chunk: Buffer) => {
        const available = Math.max(0, limit - stdoutLength);
        if (chunk.length > available) truncated = true;
        const bytes = chunk.subarray(0, available);
        if (bytes.length) stdout.push(bytes);
        stdoutLength += bytes.length;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const available = Math.max(0, limit - stderrLength);
        if (chunk.length > available) truncated = true;
        const bytes = chunk.subarray(0, available);
        if (bytes.length) stderr.push(bytes);
        stderrLength += bytes.length;
      });
      child.on('error', (cause) => {
        error = cause.message;
      });
      // close follows exit/error and stream closure; keep the last output chunks.
      child.on('close', finish);
      const terminate = (): void => {
        try {
          child.kill('SIGKILL');
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      };
      stop = (): void => {
        cancelled = true;
        terminate();
      };
      signal.addEventListener('abort', stop, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs ?? 5000);
      if (signal.aborted) stop();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      finish(null, null);
    }
  });
}
