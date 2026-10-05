// @vitest-environment node
import { type RemoteInfo, type Socket, createSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';

import type { CheckResult } from '../../shared/diagnostics';
import { parsePluBlock } from './plu';
import { transferTestProduct } from './transfer';
import {
  encodeConnect,
  encodeDisconnect,
  encodeTestProduct,
  parseCapabilities,
  sessionIdBytes,
} from './transfer-codec';

// Exact capabilities datagram captured from RLS1100 on 2026-10-05.
// It has a 3-byte header and 256-byte payload, with no application checksum.
const capturedCapabilitiesHex =
  '0e0300aa4c42312e3030aa02ab2af800010000200120210105000000000000007b57656920533d3030302e303030307d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

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

function capabilityReply(): Buffer {
  const packet = Buffer.alloc(261);
  packet[0] = 0x0e;
  packet[1] = 3;
  packet[3] = 0xaa;
  packet.write('LB1.00', 4, 'ascii');
  packet[11] = 0x50;
  packet[28] = 36;
  packet.writeUInt16LE(
    packet.subarray(0, 259).reduce((sum, byte) => sum + byte, 0),
    259,
  );
  return packet;
}

async function device(
  handler: (message: Buffer, peer: RemoteInfo, socket: Socket) => void,
): Promise<{ scaleIp: string; localAddress: string; port: number }> {
  const socket = createSocket('udp4');
  sockets.push(socket);
  socket.on('message', (message, peer) => handler(message, peer, socket));
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', resolve);
  });
  return {
    scaleIp: '127.0.0.1',
    localAddress: '127.0.0.1',
    port: socket.address().port,
  };
}

describe('vendor update encoding', () => {
  it('decodes the captured 259-byte RLS1100 reply without claiming a checksum check', () => {
    const packet = Buffer.from(capturedCapabilitiesHex, 'hex');
    expect(packet).toHaveLength(259);
    expect(parseCapabilities(packet)).toMatchObject({
      fingerprint: 'LB1.00',
      nameBytes: 36,
      family: 'LS',
      responseBytes: 259,
      checksumStatus: 'not-provided',
      headerHex: '0e0300',
    });
  });
  it.each([258, 260, 262])(
    'rejects malformed capability length %i',
    (length) => {
      const packet = Buffer.alloc(length);
      Buffer.from(capturedCapabilitiesHex, 'hex').copy(packet);
      expect(() => parseCapabilities(packet)).toThrow(/bytes/);
    },
  );
  it('requires the observed header, known fingerprint and supported width for a checksum-free reply', () => {
    const header = Buffer.from(capturedCapabilitiesHex, 'hex');
    header[1] = 2;
    expect(() => parseCapabilities(header)).toThrow(/header/);
    const fingerprint = Buffer.from(capturedCapabilitiesHex, 'hex');
    fingerprint[4] = 0;
    expect(() => parseCapabilities(fingerprint)).toThrow(/LB1.00/);
    const width = Buffer.from(capturedCapabilitiesHex, 'hex');
    width[28] = 30;
    expect(() => parseCapabilities(width)).toThrow(/36/);
  });
  it('reproduces signed IDIV session IDs, including negative IPv4 integers', () => {
    expect(sessionIdBytes('192.168.1.87').toString('hex')).toBe('cdec8d9e');
    expect(sessionIdBytes('192.168.1.8').toString('hex')).toBe('eeeb8d9e');
    expect(sessionIdBytes('10.0.0.1').toString('hex')).toBe('61217767');
  });
  it('encodes dated connect and matching disconnect with checksums', () => {
    const packet = encodeConnect(
      '192.168.1.87',
      new Date(2026, 9, 5, 12, 34, 56),
    );
    expect(packet.toString('hex')).toBe(
      '0e0100cdec8d9e26100512345600' + '00'.repeat(245) + 'ca03',
    );
    expect(
      encodeDisconnect('192.168.1.87').subarray(0, 7).toString('hex'),
    ).toBe('0e0200cdec8d9e');
  });
  it('encodes one fixed product with vendor-confirmed empty trailing slots', () => {
    const packet = encodeTestProduct(2);
    expect(packet.subarray(0, 3).toString('hex')).toBe('0b0000');
    expect(packet.subarray(3, 39).toString('ascii')).toBe(
      'TEST APPLE'.padEnd(36, ' '),
    );
    expect(packet.subarray(67, 259)).toEqual(Buffer.alloc(192));
    expect(parsePluBlock(packet).records[0]).toMatchObject({
      lfCode: '900001',
      code: '0000900001',
      priceRaw: 1234,
      unit: 4,
    });
    expect(parsePluBlock(encodeTestProduct(3)).records[0].priceRaw).toBe(12340);
    expect(() => encodeTestProduct(4 as 2)).toThrow();
  });
  it('accepts only intact known capability layouts and stops on incompatible name length', () => {
    expect(parseCapabilities(capabilityReply())).toMatchObject({
      nameBytes: 36,
      responseBytes: 261,
      checksumStatus: 'verified',
    });
    const corrupted = capabilityReply();
    corrupted[50] ^= 1;
    expect(() => parseCapabilities(corrupted)).toThrow(/checksum/);
    expect(() => parseCapabilities(Buffer.from([2]))).toThrow();
    const variant = capabilityReply();
    variant[28] = 30;
    variant.writeUInt16LE(
      variant.subarray(0, 259).reduce((sum, byte) => sum + byte, 0),
      259,
    );
    expect(() => parseCapabilities(variant)).toThrow(/36/);
  });
});

describe('UDP test transfer against a local fake device', () => {
  it.each([
    { format: '261-byte checksummed', reply: capabilityReply() },
    {
      format: '259-byte captured',
      reply: Buffer.from(capturedCapabilitiesHex, 'hex'),
    },
  ])(
    'completes four phases with $format capabilities and persists every send',
    async ({ reply }) => {
      const planned: string[] = [];
      const received: string[] = [];
      const ports: number[] = [];
      const snapshots: CheckResult[] = [];
      const profile = await device((message, peer, socket) => {
        const hex = message.toString('hex');
        expect(planned).toContain(hex);
        received.push(hex);
        ports.push(peer.port);
        socket.send(
          message[0] === 14 && message[1] === 3 ? reply : Buffer.from([2]),
          peer.port,
          peer.address,
        );
      });
      const result = await transferTestProduct(
        profile,
        { priceDecimals: 2 },
        new AbortController().signal,
        async (state) => {
          snapshots.push(state);
          const details = state.details as {
            events: { kind: string; hex?: string }[];
          };
          for (const event of details.events)
            if (event.kind === 'tx-planned' && event.hex)
              planned.push(event.hex);
        },
      );
      expect(result.status).toBe('passed');
      expect(received.map((hex) => hex.slice(0, 6))).toEqual([
        '0e0100',
        '0e0300',
        '0b0000',
        '0e0200',
      ]);
      expect(new Set(ports).size).toBe(1);
      expect(result.details).toMatchObject({
        writeOutcome: 'acknowledged',
        sessionClosed: true,
        protocolVerified: false,
        capabilities: { responseBytes: reply.length },
      });
      expect(snapshots.length).toBeGreaterThan(8);
    },
  );
  it.each([Buffer.from([0x55]), Buffer.from([2, 0]), Buffer.from([0x99])])(
    'does not send a product after invalid handshake %s',
    async (reply) => {
      const received: Buffer[] = [];
      const profile = await device((message, peer, socket) => {
        received.push(message);
        socket.send(reply, peer.port, peer.address);
      });
      const result = await transferTestProduct(
        profile,
        { priceDecimals: 2 },
        new AbortController().signal,
        async () => {},
      );
      expect(result.status).toBe('failed');
      expect(received).toHaveLength(1);
      expect(result.details).toMatchObject({ writeOutcome: 'not-sent' });
    },
  );
  it('stops before write on unknown capabilities and closes the vendor session', async () => {
    const headers: string[] = [];
    const profile = await device((message, peer, socket) => {
      headers.push(message.subarray(0, 3).toString('hex'));
      socket.send(Buffer.from([2]), peer.port, peer.address);
    });
    const result = await transferTestProduct(
      profile,
      { priceDecimals: 2 },
      new AbortController().signal,
      async () => {},
    );
    expect(result.status).toBe('failed');
    expect(headers).toEqual(['0e0100', '0e0300', '0e0200']);
  });
  it('records rejected write and performs no automatic write retry', async () => {
    const writes: Buffer[] = [];
    const profile = await device((message, peer, socket) => {
      if (message[0] === 11) writes.push(message);
      socket.send(
        message[0] === 11
          ? Buffer.from([0x55])
          : message[1] === 3
            ? capabilityReply()
            : Buffer.from([2]),
        peer.port,
        peer.address,
      );
    });
    const result = await transferTestProduct(
      profile,
      { priceDecimals: 2 },
      new AbortController().signal,
      async () => {},
    );
    expect(writes).toHaveLength(1);
    expect(result.status).toBe('failed');
    expect(result.details).toMatchObject({
      writeOutcome: 'rejected',
      sessionClosed: true,
    });
  });
  it('keeps uncertainty and captured TX after a write timeout, with no retry', async () => {
    const writes: Buffer[] = [];
    const profile = await device((message, peer, socket) => {
      if (message[0] === 11) {
        writes.push(message);
        return;
      }
      socket.send(
        message[1] === 3 ? capabilityReply() : Buffer.from([2]),
        peer.port,
        peer.address,
      );
    });
    const result = await transferTestProduct(
      profile,
      { priceDecimals: 2 },
      new AbortController().signal,
      async () => {},
    );
    expect(result.status).toBe('failed');
    expect(writes).toHaveLength(1);
    expect(result.details).toMatchObject({
      writeOutcome: 'uncertain',
      sessionClosed: true,
    });
  });
  it('cancels an in-flight write and retains its uncertain result', async () => {
    const controller = new AbortController();
    const profile = await device((message, peer, socket) => {
      if (message[0] === 11) {
        controller.abort();
        return;
      }
      socket.send(
        message[1] === 3 ? capabilityReply() : Buffer.from([2]),
        peer.port,
        peer.address,
      );
    });
    const result = await transferTestProduct(
      profile,
      { priceDecimals: 2 },
      controller.signal,
      async () => {},
    );
    expect(result.status).toBe('cancelled');
    expect(result.details).toMatchObject({ writeOutcome: 'uncertain' });
  });
  it('ignores a reply from a different UDP source port', async () => {
    const foreign = createSocket('udp4');
    sockets.push(foreign);
    const profile = await device((message, peer, socket) => {
      foreign.send(Buffer.from([0x55]), peer.port, peer.address);
      setTimeout(
        () =>
          socket.send(
            message[1] === 3 ? capabilityReply() : Buffer.from([2]),
            peer.port,
            peer.address,
          ),
        20,
      );
    });
    const result = await transferTestProduct(
      profile,
      { priceDecimals: 2 },
      new AbortController().signal,
      async () => {},
    );
    expect(result.status).toBe('passed');
    expect(
      (result.details as { events: { kind: string }[] }).events.some(
        (event) => event.kind === 'rx-ignored',
      ),
    ).toBe(true);
  });
  it('stops all sends when the report cannot be persisted', async () => {
    const received: Buffer[] = [];
    const profile = await device((message) => received.push(message));
    await expect(
      transferTestProduct(
        profile,
        { priceDecimals: 2 },
        new AbortController().signal,
        async () => {
          throw new Error('disk full');
        },
      ),
    ).rejects.toThrow('disk full');
    expect(received).toHaveLength(0);
  });
});
