// @vitest-environment node
import { type RemoteInfo, type Socket, createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

import type { CatalogProduct, UploadJob } from '../../shared/catalog';
import { encodeCatalogProduct } from './codec';
import { runUpload } from './upload';

const sockets: Socket[] = [];
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
  packet[11] = 0x02;
  return packet;
}

async function fakeScale(
  reply?: (
    packet: Buffer,
    peer: RemoteInfo,
    socket: Socket,
    writeCount: number,
  ) => void,
): Promise<{ port: number; packets: Buffer[]; peers: number[] }> {
  const socket = createSocket('udp4');
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve();
    });
  });
  const packets: Buffer[] = [];
  const peers: number[] = [];
  let writeCount = 0;
  socket.on('message', (packet, peer) => {
    packets.push(Buffer.from(packet));
    peers.push(peer.port);
    if (packet[0] === 0x0b) writeCount++;
    if (reply) reply(packet, peer, socket, writeCount);
    else
      socket.send(
        packet[1] === 3 ? capabilities() : Buffer.from([2]),
        peer.port,
        peer.address,
      );
  });
  return { port: (socket.address() as { port: number }).port, packets, peers };
}

function job(port: number): UploadJob {
  const device = {
    scaleIp: '127.0.0.1',
    localAddress: '127.0.0.1',
    port,
    nameEncoding: 'ascii' as const,
    barcodePrefix: '22',
    setupConfirmed: true,
  };
  const products: CatalogProduct[] = [1, 2].map((id) => ({
    id: String(id),
    organization_id: 'org',
    store_id: 'store',
    name: `APPLE ${id}`,
    scale_name: null,
    scale_plu: id,
    barcode: '',
    unit: 'kg',
    retail_price: '12.34',
    is_active: true,
    updated_at: '2026-10-11T00:00:00Z',
  }));
  return {
    id: 'job',
    scope: {
      apiUrl: 'http://localhost',
      userId: 'user',
      membershipId: 'member',
      organizationId: 'org',
      storeId: 'store',
      storeName: 'Store',
    },
    device,
    catalogSyncedAt: '2026-10-11T00:00:00Z',
    createdAt: '2026-10-11T00:00:00Z',
    finishedAt: null,
    status: 'running',
    items: products.map((product) => ({
      product,
      packetHex: encodeCatalogProduct(product, device).toString('hex'),
      state: 'pending',
      error: null,
    })),
    events: [],
    error: null,
    disconnectError: null,
  };
}

describe('sequential catalog upload', () => {
  it('uses the scale address for both session IDs while binding the local adapter', async () => {
    const input = job(5001);
    input.device.scaleIp = '192.168.1.87';
    input.device.localAddress = '192.168.1.89';
    const sent: Buffer[] = [];
    let bound: unknown;
    const socket = new EventEmitter() as EventEmitter & {
      bind: (options: unknown) => void;
      send: (
        packet: Buffer,
        port: number,
        address: string,
        callback: (error: Error | null) => void,
      ) => void;
      close: () => void;
    };
    socket.bind = (options): void => {
      bound = options;
      queueMicrotask(() => socket.emit('listening'));
    };
    socket.close = (): void => {};
    socket.send = (packet, port, address, callback): void => {
      sent.push(Buffer.from(packet));
      expect(address).toBe('192.168.1.87');
      expect(port).toBe(5001);
      queueMicrotask(() => {
        callback(null);
        socket.emit(
          'message',
          packet[1] === 3 ? capabilities() : Buffer.from([2]),
          {
            address: '192.168.1.87',
            port: 5001,
          },
        );
      });
    };
    const result = await runUpload(
      input,
      new AbortController().signal,
      async () => {},
      {
        createSocket: () => socket as unknown as Socket,
      },
    );
    expect(result.status).toBe('completed');
    expect(bound).toEqual({
      address: '192.168.1.89',
      port: 0,
      exclusive: true,
    });
    expect(sent[0].subarray(3, 7).toString('hex')).toBe('cdec8d9e');
    expect(sent.at(-1)!.subarray(3, 7).toString('hex')).toBe('cdec8d9e');
  });

  it('preserves early TX/RX evidence for a bulk job and rejects oversized jobs before sending', async () => {
    const server = await fakeScale();
    const input = job(server.port);
    input.items = Array.from({ length: 130 }, (_, index) => {
      const product = {
        ...input.items[0].product,
        id: String(index + 1),
        scale_plu: index + 1,
      };
      return {
        product,
        state: 'pending' as const,
        error: null,
        packetHex: encodeCatalogProduct(product, input.device).toString('hex'),
      };
    });
    const result = await runUpload(
      input,
      new AbortController().signal,
      async () => {},
      { timeoutMs: 100 },
    );
    expect(result.status).toBe('completed');
    expect(result.events).toHaveLength(266);
    expect(result.events[0].phase).toBe('connect:planned');
    expect(
      result.events.find(
        (event) => event.phase === 'product:1' && event.kind === 'rx',
      )?.hex,
    ).toBe('02');
    const oversized = job(server.port);
    oversized.items = Array.from({ length: 10001 }, () => oversized.items[0]);
    const previousPackets = server.packets.length;
    const blocked = await runUpload(
      oversized,
      new AbortController().signal,
      async () => {},
    );
    expect(blocked.status).toBe('failed');
    expect(server.packets).toHaveLength(previousPackets);
  });

  it('persists exact intent before each send and acknowledged progress before next write', async () => {
    const snapshots: UploadJob[] = [];
    const server = await fakeScale((packet, peer, socket, writes) => {
      if (packet[0] === 0x0b) {
        const saved = snapshots.at(-1)!;
        expect(saved.items[writes - 1].state).toBe('in_flight');
        expect(saved.items[writes - 1].packetHex).toBe(packet.toString('hex'));
        if (writes === 2) expect(saved.items[0].state).toBe('acknowledged');
      }
      socket.send(
        packet[1] === 3 ? capabilities() : Buffer.from([2]),
        peer.port,
        peer.address,
      );
    });
    const input = job(server.port);
    const result = await runUpload(
      input,
      new AbortController().signal,
      async (value) => {
        snapshots.push(value);
      },
      { timeoutMs: 100 },
    );
    expect(result.status).toBe('completed');
    expect(result.items.map((item) => item.state)).toEqual([
      'acknowledged',
      'acknowledged',
    ]);
    expect(
      server.packets.map((packet) => packet.subarray(0, 3).toString('hex')),
    ).toEqual(['0e0100', '0e0300', '0b0000', '0b0000', '0e0200']);
    expect(new Set(server.peers).size).toBe(1);
    expect(input.items.every((item) => item.state === 'pending')).toBe(true);
    expect(
      snapshots.some((saved) => saved.items[0].state === 'in_flight'),
    ).toBe(true);
    expect(
      result.events.some(
        (event) =>
          event.kind === 'tx' && event.hex === input.items[0].packetHex,
      ),
    ).toBe(true);
    expect(
      result.events.some((event) => event.kind === 'rx' && event.hex === '02'),
    ).toBe(true);
  });

  it('awaits durable intent and ACK writes and freezes nested device and product input', async () => {
    const server = await fakeScale();
    const input = job(server.port);
    let releaseIntent!: () => void;
    let releaseAck!: () => void;
    let seenIntent!: () => void;
    let seenAck!: () => void;
    const intentSeen = new Promise<void>((resolve) => {
      seenIntent = resolve;
    });
    const ackSeen = new Promise<void>((resolve) => {
      seenAck = resolve;
    });
    const intentGate = new Promise<void>((resolve) => {
      releaseIntent = resolve;
    });
    const ackGate = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    let intentHeld = false;
    let ackHeld = false;
    const task = runUpload(
      input,
      new AbortController().signal,
      async (saved) => {
        if (saved.items[0].state === 'in_flight' && !intentHeld) {
          intentHeld = true;
          seenIntent();
          await intentGate;
        }
        if (saved.items[0].state === 'acknowledged' && !ackHeld) {
          ackHeld = true;
          seenAck();
          await ackGate;
        }
      },
      { timeoutMs: 100 },
    );
    await intentSeen;
    input.device.scaleIp = 'invalid.example';
    input.items[0].product.name = 'MUTATED';
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(server.packets.filter((packet) => packet[0] === 0x0b)).toHaveLength(
      0,
    );
    releaseIntent();
    await ackSeen;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(server.packets.filter((packet) => packet[0] === 0x0b)).toHaveLength(
      1,
    );
    releaseAck();
    const result = await task;
    expect(result.status).toBe('completed');
    expect(result.device.scaleIp).toBe('127.0.0.1');
    expect(result.items[0].product.name).toBe('APPLE 1');
  });

  it.each(['timeout', 'unknown', 'rejected'] as const)(
    'stops after %s without retry or sending remaining products',
    async (mode) => {
      const server = await fakeScale((packet, peer, socket) => {
        if (packet[0] === 0x0b) {
          if (mode !== 'timeout')
            socket.send(
              Buffer.from([mode === 'rejected' ? 0x55 : 0x99]),
              peer.port,
              peer.address,
            );
        } else
          socket.send(
            packet[1] === 3 ? capabilities() : Buffer.from([2]),
            peer.port,
            peer.address,
          );
      });
      const result = await runUpload(
        job(server.port),
        new AbortController().signal,
        async () => {},
        { timeoutMs: 30 },
      );
      expect(result.status).toBe('failed');
      expect(result.items.map((item) => item.state)).toEqual([
        mode === 'rejected' ? 'rejected' : 'uncertain',
        'pending',
      ]);
      expect(
        server.packets.filter((packet) => packet[0] === 0x0b),
      ).toHaveLength(1);
    },
  );

  it('cancels an outstanding write as uncertain and disconnects without sending another product', async () => {
    const controller = new AbortController();
    const server = await fakeScale((packet, peer, socket) => {
      if (packet[0] === 0x0b) controller.abort();
      else
        socket.send(
          packet[1] === 3 ? capabilities() : Buffer.from([2]),
          peer.port,
          peer.address,
        );
    });
    const result = await runUpload(
      job(server.port),
      controller.signal,
      async () => {},
      { timeoutMs: 50 },
    );
    expect(result.status).toBe('cancelled');
    expect(result.items.map((item) => item.state)).toEqual([
      'uncertain',
      'pending',
    ]);
    expect(server.packets.at(-1)?.subarray(0, 3).toString('hex')).toBe(
      '0e0200',
    );
  });

  it('keeps unsent items pending when cancellation arrives during durable intent', async () => {
    const controller = new AbortController();
    const server = await fakeScale();
    const result = await runUpload(
      job(server.port),
      controller.signal,
      async (saved) => {
        if (saved.items[0].state === 'in_flight') controller.abort();
      },
      { timeoutMs: 50 },
    );
    expect(result.status).toBe('cancelled');
    expect(result.items.every((item) => item.state === 'pending')).toBe(true);
    expect(server.packets.filter((packet) => packet[0] === 0x0b)).toHaveLength(
      0,
    );
  });

  it('never sends a PLU if saving its durable intent fails', async () => {
    const server = await fakeScale();
    await expect(
      runUpload(
        job(server.port),
        new AbortController().signal,
        async (saved) => {
          if (saved.items[0].state === 'in_flight')
            throw new Error('disk full');
        },
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow('disk full');
    expect(server.packets.filter((packet) => packet[0] === 0x0b)).toHaveLength(
      0,
    );
  });

  it('stops after ACK persistence fails, leaving a durable in-flight intent for recovery', async () => {
    const server = await fakeScale();
    let durable: UploadJob | undefined;
    await expect(
      runUpload(
        job(server.port),
        new AbortController().signal,
        async (saved) => {
          if (saved.items[0].state === 'acknowledged')
            throw new Error('disk full');
          durable = saved;
        },
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow('disk full');
    expect(server.packets.filter((packet) => packet[0] === 0x0b)).toHaveLength(
      1,
    );
    expect(durable?.items.map((item) => item.state)).toEqual([
      'in_flight',
      'pending',
    ]);
  });

  it('keeps accepted products acknowledged if cleanup times out', async () => {
    const server = await fakeScale((packet, peer, socket) => {
      if (packet[1] !== 2)
        socket.send(
          packet[1] === 3 ? capabilities() : Buffer.from([2]),
          peer.port,
          peer.address,
        );
    });
    const result = await runUpload(
      job(server.port),
      new AbortController().signal,
      async () => {},
      { timeoutMs: 30 },
    );
    expect(result.status).toBe('completed');
    expect(result.items.every((item) => item.state === 'acknowledged')).toBe(
      true,
    );
    expect(result.disconnectError).toBeTruthy();
  });

  it('validates the whole job against a healthy device before opening a session', async () => {
    const server = await fakeScale();
    for (const change of [
      (value: UploadJob): void => {
        value.device.scaleIp = 'example.org';
      },
      (value: UploadJob): void => {
        value.device.localAddress = '::1';
      },
      (value: UploadJob): void => {
        value.device.port = 65536;
      },
      (value: UploadJob): void => {
        value.items[1].packetHex = '00';
      },
      (value: UploadJob): void => {
        value.items[1].product.store_id = 'another-store';
      },
    ]) {
      const input = job(server.port);
      change(input);
      const result = await runUpload(
        input,
        new AbortController().signal,
        async () => {},
        { timeoutMs: 50 },
      );
      expect(result.status).toBe('failed');
      expect(result.items.every((item) => item.state === 'pending')).toBe(true);
    }
    expect(server.packets).toHaveLength(0);
  });

  it('blocks unknown capabilities before any PLU write', async () => {
    const server = await fakeScale((packet, peer, socket) => {
      socket.send(
        packet[1] === 3 ? Buffer.alloc(259) : Buffer.from([2]),
        peer.port,
        peer.address,
      );
    });
    const result = await runUpload(
      job(server.port),
      new AbortController().signal,
      async () => {},
      { timeoutMs: 50 },
    );
    expect(result.status).toBe('failed');
    expect(result.items.every((item) => item.state === 'pending')).toBe(true);
    expect(server.packets.filter((packet) => packet[0] === 0x0b)).toHaveLength(
      0,
    );
  });

  it('ignores an ACK from a different UDP port and preserves the uncertain result', async () => {
    const stranger = createSocket('udp4');
    sockets.push(stranger);
    const server = await fakeScale((packet, peer, socket) => {
      if (packet[0] === 0x0b)
        stranger.send(Buffer.from([2]), peer.port, peer.address);
      else
        socket.send(
          packet[1] === 3 ? capabilities() : Buffer.from([2]),
          peer.port,
          peer.address,
        );
    });
    const result = await runUpload(
      job(server.port),
      new AbortController().signal,
      async () => {},
      { timeoutMs: 30 },
    );
    expect(result.items.map((item) => item.state)).toEqual([
      'uncertain',
      'pending',
    ]);
    expect(
      result.events.filter(
        (event) => event.phase === 'product:1' && event.kind === 'rx',
      ),
    ).toHaveLength(0);
  });

  it('retains the whole unexpected response for diagnosis without sending another product', async () => {
    const unexpected = Buffer.alloc(500, 0x99);
    const server = await fakeScale((packet, peer, socket) => {
      socket.send(
        packet[0] === 0x0b
          ? unexpected
          : packet[1] === 3
            ? capabilities()
            : Buffer.from([2]),
        peer.port,
        peer.address,
      );
    });
    const result = await runUpload(
      job(server.port),
      new AbortController().signal,
      async () => {},
      { timeoutMs: 50 },
    );
    expect(result.items.map((item) => item.state)).toEqual([
      'uncertain',
      'pending',
    ]);
    expect(
      result.events.find(
        (event) => event.phase === 'product:1' && event.kind === 'rx',
      )?.hex,
    ).toBe('99'.repeat(500));
  });
});
