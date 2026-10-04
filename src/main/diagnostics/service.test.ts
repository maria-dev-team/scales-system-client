// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CheckResult } from '../../shared/diagnostics';
import * as probes from './probes';
import { DiagnosticsService } from './service';

vi.mock('./probes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./probes')>();
  const pass = async (): Promise<CheckResult> => ({
    status: 'passed',
    summary: 'OK',
  });
  return {
    ...actual,
    getNetworkAdapters: vi.fn(() => [
      {
        name: 'Ethernet',
        address: '192.168.50.2',
        netmask: '255.255.255.0',
        mac: '00:11:22:33:44:55',
      },
    ]),
    runNetworkCommands: vi.fn(pass),
    runArp: vi.fn(pass),
    checkReachability: vi.fn(pass),
    checkUdpLoopback: vi.fn(pass),
    checkUdpBind: vi.fn(pass),
  };
});

let directory: string;
let service: DiagnosticsService;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(probes.getNetworkAdapters).mockReturnValue([
    {
      name: 'Ethernet',
      address: '192.168.50.2',
      netmask: '255.255.255.0',
      mac: '00:11:22:33:44:55',
    },
  ]);
  directory = await mkdtemp(join(tmpdir(), 'scales-diagnostics-'));
  service = new DiagnosticsService({
    dataDirectory: join(directory, 'data'),
    logsDirectory: join(directory, 'logs'),
    appVersion: '0.1.0',
    platform: 'darwin',
  });
});

afterEach(async () => {
  await service.cancel();
  await rm(directory, { recursive: true, force: true });
});

async function finished(): Promise<void> {
  await vi.waitFor(() => expect(service.isRunning()).toBe(false));
}

describe('DiagnosticsService', () => {
  it('retains a saved profile while its adapter is unavailable and uses it after reconnection', async () => {
    await service.initialize();
    await finished();
    await service.saveProfile({
      scaleIp: '192.168.50.10',
      port: 5001,
      localAddress: '192.168.50.2',
    });
    await finished();
    const available = probes.getNetworkAdapters();
    vi.mocked(probes.getNetworkAdapters).mockReturnValue([]);
    service = new DiagnosticsService({
      dataDirectory: join(directory, 'data'),
      logsDirectory: join(directory, 'logs'),
      appVersion: '0.1.0',
    });
    await service.initialize();
    await finished();
    expect(service.getState().profile?.scaleIp).toBe('192.168.50.10');
    expect(
      service.getState().run?.steps.find((step) => step.id === 'reachability')
        ?.status,
    ).toBe('failed');
    vi.mocked(probes.getNetworkAdapters).mockReturnValue(available);
    service.rerun();
    await finished();
    expect(
      service.getState().run?.steps.find((step) => step.id === 'reachability')
        ?.status,
    ).toBe('passed');
  });
  it('starts only once, persists results, and skips target checks without configuration', async () => {
    await Promise.all([service.initialize(), service.initialize()]);
    await finished();
    const run = service.getState().run!;
    await service.initialize();
    expect(service.getState().run?.id).toBe(run.id);
    expect(run.steps.find((step) => step.id === 'reachability')?.status).toBe(
      'skipped',
    );
    expect(run.protocolStatus).toBe('unverified');
    const saved = JSON.parse(
      await readFile(join(run.reportDirectory, 'report.json'), 'utf8'),
    );
    expect(saved.status).toBe('completed');
    expect(saved.testProduct.name).toBe('TEST APPLE');
    expect(
      await readFile(join(run.reportDirectory, 'report.txt'), 'utf8'),
    ).toContain('unverified');
    expect(await readdir(join(directory, 'logs', 'diagnostics'))).toHaveLength(
      1,
    );
  });

  it('saves the profile and starts a new run without replacing the previous report', async () => {
    await service.initialize();
    await finished();
    const previous = service.getState().run!;
    await service.saveProfile({
      scaleIp: '192.168.50.10',
      port: 5001,
      localAddress: '192.168.50.2',
    });
    await finished();
    expect(service.getState().run?.id).not.toBe(previous.id);
    expect(
      service.getState().run?.steps.find((step) => step.id === 'reachability')
        ?.status,
    ).toBe('passed');
    const config = JSON.parse(
      await readFile(join(directory, 'data', 'diagnostics.json'), 'utf8'),
    );
    expect(config.profile.scaleIp).toBe('192.168.50.10');
    expect(config.testProduct.pricePerKg).toBe('12.34');
    expect(
      JSON.parse(
        await readFile(join(previous.reportDirectory, 'report.json'), 'utf8'),
      ).id,
    ).toBe(previous.id);
  });

  it('preserves failed command evidence in JSON and readable text', async () => {
    vi.mocked(probes.runNetworkCommands).mockResolvedValueOnce({
      status: 'warning',
      summary: 'command failure',
      commands: [
        {
          executable: 'ipconfig.exe',
          args: ['/all'],
          startedAt: '2026-10-04T00:00:00Z',
          finishedAt: '2026-10-04T00:00:01Z',
          durationMs: 1000,
          stdout: 'Адаптер',
          stderr: 'failure',
          stdoutBase64: 'gKSk',
          stderrBase64: 'ZmFpbHVyZQ==',
          encoding: 'ibm866',
          exitCode: 1,
          signal: null,
          timedOut: false,
          cancelled: false,
        },
      ],
    });
    await service.initialize();
    await finished();
    const run = service.getState().run!;
    const saved = JSON.parse(
      await readFile(join(run.reportDirectory, 'report.json'), 'utf8'),
    );
    expect(
      saved.steps.find((step: { id: string }) => step.id === 'network-commands')
        .commands[0].stdoutBase64,
    ).toBe('gKSk');
    const text = await readFile(
      join(run.reportDirectory, 'report.txt'),
      'utf8',
    );
    expect(text).toContain('Адаптер');
    expect(text).toContain('failure');
    expect(text).toContain('ipconfig.exe');
  });

  it('cancels an active probe and retains completed and cancelled results', async () => {
    vi.mocked(probes.runNetworkCommands).mockImplementationOnce(
      (_platform, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                status: 'cancelled',
                summary: 'Stopped',
                commands: [],
              }),
            { once: true },
          );
        }),
    );
    await service.initialize();
    await vi.waitFor(() =>
      expect(
        service
          .getState()
          .run?.steps.find((step) => step.id === 'network-commands')?.status,
      ).toBe('running'),
    );
    await service.cancel();
    const run = service.getState().run!;
    expect(run.status).toBe('cancelled');
    expect(run.steps[0]?.status).toBe('passed');
    expect(
      run.steps.find((step) => step.id === 'network-commands')?.status,
    ).toBe('cancelled');
    expect(
      run.steps.some(
        (step) => step.status === 'running' || step.status === 'pending',
      ),
    ).toBe(false);
    expect(
      JSON.parse(
        await readFile(join(run.reportDirectory, 'report.json'), 'utf8'),
      ).status,
    ).toBe('cancelled');
  });

  it('keeps diagnostics available and reports a log directory write failure', async () => {
    await writeFile(join(directory, 'logs'), 'not a directory');
    await service.initialize();
    await finished();
    expect(service.getState().run?.persistenceError).toBeTruthy();
    expect(service.getState().run?.steps[0]?.status).toBe('passed');
  });
});
