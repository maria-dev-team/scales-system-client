// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { runCommand } from './command';

describe('diagnostic command runner', () => {
  it('preserves exact bytes and decodes Russian OEM output', async () => {
    const result = await runCommand(
      process.execPath,
      [
        '-e',
        'process.stdout.write(Buffer.from([0x8f,0xe0,0xa8,0xa2,0xa5,0xe2])); process.stderr.write("detail")',
      ],
      new AbortController().signal,
      { encoding: 'ibm866' },
    );
    expect(result.stdout).toBe('Привет');
    expect(Buffer.from(result.stdoutBase64, 'base64')).toEqual(
      Buffer.from([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2]),
    );
    expect(result.stderr).toBe('detail');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records nonzero exit and the final stream output', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("last");process.exitCode=7'],
      new AbortController().signal,
    );
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('last');
  });

  it('terminates timed out commands and retains captured output', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'console.log("started");setInterval(()=>{},1000)'],
      new AbortController().signal,
      { timeoutMs: 200 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('started');
    expect(result.cancelled).toBe(false);
  });

  it('cancels a running command', async () => {
    const controller = new AbortController();
    const task = runCommand(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      controller.signal,
    );
    controller.abort();
    expect((await task).cancelled).toBe(true);
  });

  it('does not spawn an already cancelled command', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCommand(
      'missing-command-that-must-not-run',
      [],
      controller.signal,
    );
    expect(result.cancelled).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('records executable launch failures', async () => {
    const result = await runCommand(
      'missing-command-diagnostics-test',
      [],
      new AbortController().signal,
    );
    expect(result.error).toContain('ENOENT');
    expect(result.exitCode).not.toBe(0);
  });

  it('bounds captured output and explicitly marks truncation', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(1000))'],
      new AbortController().signal,
      { maxBytes: 32 },
    );
    expect(result.stdout.length).toBe(32);
    expect(result.truncated).toBe(true);
  });
});
