// @vitest-environment node
import { type RemoteInfo, type Socket, createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

import type { ClearPluJob } from '../../shared/catalog';
import { encodeClearPluPackets, runClearPlu } from './clear';

const sockets: Socket[] = [];
const options = { timeoutMs: 100, clearTimeoutMs: 100 };
const goldenPackets = [
  '0e04000004ff0700' + '00'.repeat(251) + '1c01',
  '0e04000002ff0200' + '00'.repeat(251) + '1501',
];

afterEach(async () => {
  await Promise.all(
    sockets.splice(0).map(
      (socket) =>
        new Promise<void>((resolve) => {
          try {
            socket.close(() => resolve());
          } catch {
            resolve();
          }
        }),
    ),
  );
});

function capabilities(): Buffer {
  const packet = Buffer.alloc(259);
  packet.set([0x0e, 3, 0]);
  packet.write('LB1.00', 4, 'ascii');
  packet[11] = 2;
  return packet;
}

async function fakeScale(
  reply?: (packet: Buffer, peer: RemoteInfo, socket: Socket) => boolean | void,
): Promise<{
  port: number;
  packets: Buffer[];
  peers: number[];
}> {
  const socket = createSocket('udp4');
  sockets.push(socket);
  const packets: Buffer[] = [];
  const peers: number[] = [];
  socket.on('message', (packet, peer) => {
    packets.push(Buffer.from(packet));
    peers.push(peer.port);
    if (reply?.(packet, peer, socket) === false) return;
    socket.send(
      packet[1] === 3 ? capabilities() : Buffer.from([2]),
      peer.port,
      peer.address,
    );
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve();
    });
  });
  return { port: socket.address().port, packets, peers };
}

function job(port: number): ClearPluJob {
  return {
    id: 'clear-job',
    scope: {
      apiUrl: 'http://localhost',
      userId: 'user',
      membershipId: 'member',
      organizationId: 'org',
      storeId: 'store',
      storeName: 'Store',
    },
    device: {
      scaleIp: '127.0.0.1',
      localAddress: '127.0.0.1',
      port,
      nameEncoding: 'ascii',
      barcodePrefix: '22',
      setupConfirmed: true,
    },
    createdAt: '2026-10-11T00:00:00.000Z',
    finishedAt: null,
    status: 'running',
    commandState: 'pending',
    events: [],
    error: null,
    disconnectError: null,
  };
}

describe('PLU-only range clear', () => {
  it('encodes only the vendor PLU ranges in vendor order, without message memory', () => {
    expect(
      encodeClearPluPackets().map((packet) => packet.toString('hex')),
    ).toEqual(goldenPackets);
    const packets = encodeClearPluPackets();
    packets[0].fill(0xff);
    expect(encodeClearPluPackets()[0].toString('hex')).toBe(goldenPackets[0]);
  });

  it('persists each range intent and ACK before proceeding, using one bound session', async () => {
    const snapshots: ClearPluJob[] = [];
    const atSend: Array<{ command: number; snapshot: ClearPluJob }> = [];
    const scale = await fakeScale((packet) => {
      atSend.push({ command: packet[1], snapshot: snapshots.at(-1)! });
    });
    const input = job(scale.port);
    const result = await runClearPlu(
      input,
      new AbortController().signal,
      async (snapshot) => {
        snapshots.push(snapshot);
      },
      options,
    );
    expect(scale.packets.map((packet) => packet[1])).toEqual([1, 3, 4, 4, 2]);
    expect(
      scale.packets
        .filter((packet) => packet[1] === 4)
        .map((packet) => packet.toString('hex')),
    ).toEqual(goldenPackets);
    expect(new Set(scale.peers).size).toBe(1);
    expect(atSend[2].snapshot.commandState).toBe('in_flight');
    expect(atSend[2].snapshot.events.at(-1)).toMatchObject({
      phase: 'clear:extended:planned',
      kind: 'tx',
      hex: goldenPackets[0],
    });
    expect(atSend[3].snapshot.events).toContainEqual(
      expect.objectContaining({
        phase: 'clear:extended',
        kind: 'rx',
        hex: '02',
      }),
    );
    expect(atSend[3].snapshot.events.at(-1)).toMatchObject({
      phase: 'clear:base:planned',
      kind: 'tx',
      hex: goldenPackets[1],
    });
    expect(atSend[3].snapshot.commandState).toBe('in_flight');
    expect(atSend[4].snapshot.commandState).toBe('acknowledged');
    expect(result).toMatchObject({
      status: 'completed',
      commandState: 'acknowledged',
      error: null,
      disconnectError: null,
    });
    expect(result.finishedAt).not.toBeNull();
    expect(input).toEqual(job(scale.port));
    expect(snapshots[0].events).toHaveLength(1);
  });

  it.each([
    'fingerprint',
    'family',
    'unknown-family',
    'unknown-family-checksummed',
    'name',
    'header',
    'checksum',
  ] as const)(
    'blocks clears for unsupported %s capabilities',
    async (invalid) => {
      const scale = await fakeScale((packet, peer, socket) => {
        if (packet[1] !== 3) return;
        let response = capabilities();
        if (invalid === 'fingerprint') response.write('LB2.00', 4, 'ascii');
        if (invalid === 'family') response[11] = 0x50;
        if (invalid.startsWith('unknown-family')) response[11] = 0x51;
        if (invalid === 'name') response[28] = 48;
        if (
          invalid === 'header' ||
          invalid === 'checksum' ||
          invalid === 'unknown-family-checksummed'
        ) {
          response = Buffer.concat([response, Buffer.alloc(2)]);
          if (invalid === 'header') response[1] = 4;
          response.writeUInt16LE(
            response.subarray(0, 259).reduce((sum, byte) => sum + byte, 0),
            259,
          );
          if (invalid === 'checksum') response[259] ^= 1;
        }
        socket.send(response, peer.port, peer.address);
        return false;
      });
      const result = await runClearPlu(
        job(scale.port),
        new AbortController().signal,
        async () => {},
        options,
      );
      expect(result).toMatchObject({
        status: 'failed',
        commandState: 'pending',
      });
      expect(scale.packets.map((packet) => packet[1])).toEqual([1, 3, 2]);
    },
  );

  it.each([
    { range: 1, response: 'nak', state: 'rejected' },
    { range: 2, response: 'nak', state: 'uncertain' },
    { range: 1, response: 'timeout', state: 'uncertain' },
    { range: 2, response: 'timeout', state: 'uncertain' },
    { range: 1, response: 'unknown', state: 'uncertain' },
  ])(
    'stops without retries on $response for range $range',
    async ({ range, response, state }) => {
      let clears = 0;
      const scale = await fakeScale((packet, peer, socket) => {
        if (packet[1] !== 4 || ++clears !== range) return;
        if (response !== 'timeout')
          socket.send(
            Buffer.from([response === 'nak' ? 0x55 : 0x03]),
            peer.port,
            peer.address,
          );
        return false;
      });
      const result = await runClearPlu(
        job(scale.port),
        new AbortController().signal,
        async () => {},
        options,
      );
      expect(result).toMatchObject({ status: 'failed', commandState: state });
      expect(clears).toBe(range);
      expect(scale.packets.at(-1)?.[1]).toBe(2);
      if (response !== 'timeout')
        expect(result.events).toContainEqual(
          expect.objectContaining({
            kind: 'rx',
            phase: range === 1 ? 'clear:extended' : 'clear:base',
            hex: response === 'nak' ? '55' : '03',
          }),
        );
    },
  );

  it.each([1, 2])(
    'marks cancellation after range %s was sent as uncertain, without sending more clears',
    async (range) => {
      const controller = new AbortController();
      let clears = 0;
      const scale = await fakeScale((packet) => {
        if (packet[1] === 4 && ++clears === range) {
          controller.abort();
          return false;
        }
        return undefined;
      });
      const result = await runClearPlu(
        job(scale.port),
        controller.signal,
        async () => {},
        options,
      );
      expect(result).toMatchObject({
        status: 'cancelled',
        commandState: 'uncertain',
      });
      expect(clears).toBe(range);
      expect(scale.packets.at(-1)?.[1]).toBe(2);
    },
  );

  it('keeps unsent clear pending when cancelled during durable intent', async () => {
    const controller = new AbortController();
    const scale = await fakeScale();
    const result = await runClearPlu(
      job(scale.port),
      controller.signal,
      async (snapshot) => {
        if (snapshot.events.at(-1)?.phase === 'clear:extended:planned')
          controller.abort();
      },
      options,
    );
    expect(result).toMatchObject({
      status: 'cancelled',
      commandState: 'pending',
    });
    expect(scale.packets.map((packet) => packet[1])).toEqual([1, 3, 2]);
  });

  it.each([
    'clear:extended:planned',
    'clear:extended',
    'clear:base:planned',
    'clear:base',
    'acknowledged',
  ])(
    'stops every send including disconnect when persistence fails at %s',
    async (phase) => {
      const scale = await fakeScale();
      const failure = new Error('disk full');
      await expect(
        runClearPlu(
          job(scale.port),
          new AbortController().signal,
          async (snapshot) => {
            if (
              snapshot.events.at(-1)?.phase === phase ||
              (phase === 'acknowledged' &&
                snapshot.commandState === 'acknowledged')
            )
              throw failure;
          },
          options,
        ),
      ).rejects.toBe(failure);
      const expectedClears =
        phase === 'clear:extended:planned'
          ? 0
          : phase === 'clear:base' || phase === 'acknowledged'
            ? 2
            : 1;
      expect(scale.packets.filter((packet) => packet[1] === 4)).toHaveLength(
        expectedClears,
      );
      expect(scale.packets.some((packet) => packet[1] === 2)).toBe(false);
    },
  );

  it('retains both clear ACKs when session disconnect times out', async () => {
    const scale = await fakeScale((packet) =>
      packet[1] === 2 ? false : undefined,
    );
    const result = await runClearPlu(
      job(scale.port),
      new AbortController().signal,
      async () => {},
      options,
    );
    expect(result).toMatchObject({
      status: 'completed',
      commandState: 'acknowledged',
      error: null,
    });
    expect(result.disconnectError).toBeTruthy();
  });

  it('uses the longer erase timeout for each range while keeping session commands bounded', async () => {
    const scale = await fakeScale((packet, peer, socket) => {
      if (packet[1] !== 4) return;
      setTimeout(
        () => socket.send(Buffer.from([2]), peer.port, peer.address),
        60,
      );
      return false;
    });
    const result = await runClearPlu(
      job(scale.port),
      new AbortController().signal,
      async () => {},
      { timeoutMs: 30, clearTimeoutMs: 250 },
    );
    expect(result.commandState).toBe('acknowledged');
    expect(scale.packets.map((packet) => packet[1])).toEqual([1, 3, 4, 4, 2]);
  });

  it('preserves an entire unexpected response and stops after the first range', async () => {
    const response = Buffer.alloc(500, 0xab);
    const scale = await fakeScale((packet, peer, socket) => {
      if (packet[1] !== 4) return;
      socket.send(response, peer.port, peer.address);
      return false;
    });
    const result = await runClearPlu(
      job(scale.port),
      new AbortController().signal,
      async () => {},
      options,
    );
    expect(result.commandState).toBe('uncertain');
    expect(result.events).toContainEqual(
      expect.objectContaining({
        phase: 'clear:extended',
        kind: 'rx',
        hex: 'ab'.repeat(500),
      }),
    );
    expect(scale.packets.filter((packet) => packet[1] === 4)).toHaveLength(1);
  });

  it('ignores a foreign-port ACK instead of clearing the next range', async () => {
    const stranger = createSocket('udp4');
    sockets.push(stranger);
    const scale = await fakeScale((packet, peer) => {
      if (packet[1] === 4) {
        stranger.send(Buffer.from([2]), peer.port, peer.address);
        return false;
      }
      return undefined;
    });
    const result = await runClearPlu(
      job(scale.port),
      new AbortController().signal,
      async () => {},
      options,
    );
    expect(result.commandState).toBe('uncertain');
    expect(scale.packets.filter((packet) => packet[1] === 4)).toHaveLength(1);
    expect(
      result.events.filter(
        (entry) => entry.kind === 'rx' && entry.phase.startsWith('clear:'),
      ),
    ).toEqual([]);
  });

  it.each([
    'status',
    'state',
    'events',
    'finishedAt',
    'address',
    'port',
    'timeout',
  ] as const)(
    'rejects invalid new job (%s) before opening a socket',
    async (invalid) => {
      const input = job(5001);
      if (invalid === 'status') input.status = 'completed';
      if (invalid === 'state') input.commandState = 'uncertain';
      if (invalid === 'events')
        input.events.push({ at: input.createdAt, kind: 'tx', phase: 'old' });
      if (invalid === 'finishedAt') input.finishedAt = input.createdAt;
      if (invalid === 'address') input.device.scaleIp = 'example.com';
      if (invalid === 'port') input.device.port = 0;
      let opened = false;
      const result = await runClearPlu(
        input,
        new AbortController().signal,
        async () => {},
        {
          ...options,
          clearTimeoutMs: invalid === 'timeout' ? 0 : 100,
          createSocket: () => {
            opened = true;
            throw new Error('should not open');
          },
        },
      );
      expect(opened).toBe(false);
      expect(result.status).toBe('failed');
    },
  );

  it.each(['cancel', 'timeout'])(
    'closes a socket when bind cannot complete (%s)',
    async (failure) => {
      const controller = new AbortController();
      const socket = new EventEmitter() as EventEmitter & {
        bind: () => void;
        close: () => void;
      };
      let closed = false;
      socket.bind = () => {
        if (failure === 'cancel') controller.abort();
      };
      socket.close = () => {
        closed = true;
      };
      const result = await runClearPlu(
        job(5001),
        controller.signal,
        async () => {},
        { ...options, createSocket: () => socket as unknown as Socket },
      );
      expect(result).toMatchObject({
        status: failure === 'cancel' ? 'cancelled' : 'failed',
        commandState: 'pending',
      });
      expect(closed).toBe(true);
    },
  );
});
