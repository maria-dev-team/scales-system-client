// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CommandResult,
  DiagnosticProfile,
  NetworkAdapter,
} from '../../shared/diagnostics';
import { runCommand } from './command';
import {
  checkReachability,
  checkSubnet,
  checkUdpBind,
  checkUdpLoopback,
  parseProfile,
  runNetworkCommands,
  validateProfile,
} from './probes';

vi.mock('./command', () => ({ runCommand: vi.fn() }));

const adapters: NetworkAdapter[] = [
  {
    name: 'Ethernet',
    address: '192.168.1.2',
    netmask: '255.255.255.0',
    mac: '01:02:03:04:05:06',
  },
];
const profile: DiagnosticProfile = {
  scaleIp: '192.168.1.88',
  port: 5001,
  localAddress: '192.168.1.2',
};
const output = (stdout: string, exitCode = 0): CommandResult => ({
  executable: 'test',
  args: [],
  startedAt: '',
  finishedAt: '',
  durationMs: 1,
  stdout,
  stderr: '',
  stdoutBase64: '',
  stderrBase64: '',
  encoding: 'utf-8',
  exitCode,
  signal: null,
  timedOut: false,
  cancelled: false,
});

beforeEach(() => vi.resetAllMocks());

describe('profile validation and subnet checks', () => {
  it('parses a saved profile independently of currently connected adapters', () => {
    expect(parseProfile(profile)).toEqual(profile);
    expect(() =>
      parseProfile({ ...profile, localAddress: '127.0.0.1' }),
    ).toThrow();
    expect(() =>
      parseProfile({ ...profile, localAddress: 'adapter-name' }),
    ).toThrow();
  });
  it('accepts a valid profile and warns on a different subnet', () => {
    expect(validateProfile(profile, adapters)).toEqual(profile);
    expect(checkSubnet(profile, adapters).status).toBe('passed');
    const otherSubnet = { ...profile, scaleIp: '192.168.2.88' };
    expect(validateProfile(otherSubnet, adapters)).toEqual(otherSubnet);
    expect(checkSubnet(otherSubnet, adapters).status).toBe('warning');
  });

  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.168.1.255',
    '192.168.1.0',
    '192.168.1.2',
    '192.168.1.88;whoami',
    'example.com',
    '192.168.001.88',
    '240.0.0.1',
  ])('rejects invalid or non-device target %s', (scaleIp) => {
    expect(() => validateProfile({ ...profile, scaleIp }, adapters)).toThrow();
  });

  it.each([0, 65536, 1.5, '5001'])('rejects invalid port %s', (port) => {
    expect(() => validateProfile({ ...profile, port }, adapters)).toThrow();
  });

  it('rejects a removed adapter and malformed input', () => {
    expect(() => validateProfile(profile, [])).toThrow(/адаптер/i);
    expect(() => validateProfile(null, adapters)).toThrow();
    expect(checkSubnet(profile, []).status).toBe('failed');
  });
});

describe('native probes', () => {
  it('records Windows output and never infers a ping reply from exit zero', async () => {
    vi.mocked(runCommand).mockImplementation(async (executable, args) => {
      if (executable.endsWith('ping.exe'))
        return output('Reply from gateway: Destination host unreachable.');
      if (
        args.some((arg) => arg.includes('System.Net.NetworkInformation.Ping'))
      )
        return output('{"Status":"DestinationHostUnreachable"}');
      return output('866');
    });
    const result = await checkReachability(
      profile,
      'win32',
      new AbortController().signal,
    );
    expect(result.status).toBe('warning');
    expect(
      result.commands?.some((command) =>
        command.stdout.includes('unreachable'),
      ),
    ).toBe(true);
    expect(runCommand).toHaveBeenCalledWith(
      expect.stringContaining('ping.exe'),
      ['-n', '2', '-w', '1000', profile.scaleIp],
      expect.anything(),
      expect.anything(),
    );
  });

  it('requires explicit .NET Success for a confirmed Windows reply', async () => {
    vi.mocked(runCommand).mockImplementation(async (executable, args) => {
      if (executable.endsWith('ping.exe'))
        return output('localized native output');
      return output(
        args.some((arg) => arg.includes('System.Net.NetworkInformation.Ping'))
          ? '{"Status":"Success","Address":"192.168.1.88","RoundtripTime":2}'
          : '866',
      );
    });
    expect(
      (await checkReachability(profile, 'win32', new AbortController().signal))
        .status,
    ).toBe('passed');
  });

  it('reports malformed .NET output as inconclusive', async () => {
    vi.mocked(runCommand).mockResolvedValue(output('unknown'));
    expect(
      (await checkReachability(profile, 'win32', new AbortController().signal))
        .status,
    ).toBe('warning');
  });

  it('records all config commands including nonzero exit', async () => {
    vi.mocked(runCommand).mockResolvedValue(output('error', 1));
    const result = await runNetworkCommands(
      'darwin',
      new AbortController().signal,
    );
    expect(result.status).toBe('warning');
    expect(result.commands).toHaveLength(2);
  });

  it('does not mistake a macOS unreachable response for an echo reply', async () => {
    vi.mocked(runCommand).mockResolvedValue(
      output('92 bytes from 192.168.1.1: Destination Host Unreachable', 0),
    );
    expect(
      (await checkReachability(profile, 'darwin', new AbortController().signal))
        .status,
    ).toBe('warning');
    vi.mocked(runCommand).mockResolvedValue(
      output('64 bytes from 192.168.1.88: icmp_seq=0 ttl=64 time=0.5 ms', 0),
    );
    expect(
      (await checkReachability(profile, 'darwin', new AbortController().signal))
        .status,
    ).toBe('passed');
  });

  it('exchanges a UDP payload only over loopback and closes its sockets', async () => {
    expect((await checkUdpLoopback(new AbortController().signal)).status).toBe(
      'passed',
    );
  });

  it('binds locally without sending a UDP payload to the target', async () => {
    expect(
      (
        await checkUdpBind(
          { ...profile, localAddress: '127.0.0.1' },
          new AbortController().signal,
        )
      ).status,
    ).toBe('passed');
  });

  it('does not open sockets after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await checkUdpLoopback(controller.signal)).status).toBe(
      'cancelled',
    );
    expect((await checkUdpBind(profile, controller.signal)).status).toBe(
      'cancelled',
    );
  });
});
