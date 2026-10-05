import { isIPv4 } from 'node:net';

// Source addresses refer to the native RLS1000 v1.129 executable.
function checksum(packet: Buffer): number {
  return packet.subarray(0, 259).reduce((sum, byte) => sum + byte, 0) & 0xffff;
}

function finish(packet: Buffer): Buffer {
  // VA 6D4CB2 / 793A48: sum bytes 0..258, followed by the low/high bytes.
  packet.writeUInt16LE(checksum(packet), 259);
  return packet;
}

function bcd(value: number): number {
  return (Math.trunc(value / 10) << 4) + (value % 10);
}

export function sessionIdBytes(ip: string): Buffer {
  if (!isIPv4(ip)) throw new Error('Session ID requires an IPv4 address');
  // VA 6B5118 -> 6D4188 -> 6D4B5E: signed IPv4 integer, signed IDIV,
  // then reversed four bytes. Negative remainders are intentional, not BCD.
  let value = ip
    .split('.')
    .reduce((result, octet) => (result << 8) | Number(octet), 0);
  const bytes = Buffer.alloc(4);
  for (let index = 0; index < 4; index++) {
    const quotient = Math.trunc(value / 10);
    const high = quotient - Math.trunc(quotient / 10) * 10;
    const low = value - quotient * 10;
    bytes[index] = ((high << 4) + low) & 0xff;
    value = Math.trunc(value / 100);
  }
  return bytes;
}

export function encodeConnect(ip: string, date: Date): Buffer {
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid session date');
  const packet = Buffer.alloc(261);
  packet[0] = 0x0e;
  packet[1] = 1;
  sessionIdBytes(ip).copy(packet, 3);
  // VA 6D4B82..6D4C23: local YY MM DD hh mm ss, then BaudRate (CFG: 0).
  packet.set(
    [
      bcd(date.getFullYear() % 100),
      bcd(date.getMonth() + 1),
      bcd(date.getDate()),
      bcd(date.getHours()),
      bcd(date.getMinutes()),
      bcd(date.getSeconds()),
    ],
    7,
  );
  return finish(packet);
}

export function encodeDisconnect(ip: string): Buffer {
  // VA 6D4E44: same session ID, command 0E 02 00, zero-filled payload.
  const packet = Buffer.alloc(261);
  packet[0] = 0x0e;
  packet[1] = 2;
  sessionIdBytes(ip).copy(packet, 3);
  return finish(packet);
}

export function encodeCapabilitiesRequest(): Buffer {
  // VA 7A7838..7A7855 -> 6D46A0: 0E 03 00 + FF 0F 00 + zero padding.
  const packet = Buffer.alloc(261);
  packet.set([0x0e, 3, 0, 0xff, 0x0f, 0]);
  return finish(packet);
}

export function encodeTestProduct(priceDecimals: 2 | 3): Buffer {
  if (priceDecimals !== 2 && priceDecimals !== 3)
    throw new Error('Test price requires 2 or 3 decimal places');
  // VA 793558: index 0 selects 0B (update), with four 64-byte slots.
  // VA 792341..792366: update zero-initializes all slots and fills selected PLUs.
  const packet = Buffer.alloc(261);
  packet[0] = 0x0b;
  const record = packet.subarray(3, 67);
  record.fill(0x20, 0, 36);
  record.write('TEST APPLE', 0, 'ascii');
  // VA 79370F: LFCode is six decimal digits, including the No Limit variant.
  record.set([0x90, 0, 1], 36);
  // VA 793770..793799: department BCD and raw barcode-type byte.
  // These are the bundled sample's values; barcode contents need physical checking.
  record[41] = 2;
  record[42] = 0x20;
  // VA 7937A2: four BCD price bytes. 12.34 is 1234 or 12340 scale units.
  record.set(priceDecimals === 2 ? [0, 0, 0x12, 0x34] : [0, 1, 0x23, 0x40], 43);
  // VA 7937D1: unit nibble 4; supplied [User Weight Unit] maps Unit4 to kg.
  record[47] = 4;
  // VA 7939EF -> 78AF5C: Code 0000900001 as ten BCD digits.
  record.set([0, 0, 0x90, 0, 1], 59);
  return finish(packet);
}

export function parseCapabilities(packet: Buffer): {
  nameBytes: 36;
  fingerprint: 'LB1.00';
  pluType: 'unlimited';
  family: 'LP' | 'LS';
  headerHex: string;
  responseBytes: 259 | 261;
  checksumStatus: 'not-provided' | 'verified';
  flags: {
    payload0: number;
    payload7: number;
    payload8: number;
    payload9: number;
    payload22: number;
    payload23: number;
    payload24: number;
  };
} {
  // The 2026-10-05 hardware capture contains 259 bytes: header + payload only.
  // VA 6D53F4 retains the actual receive length; 6D49CD copies an internal
  // 261-byte buffer, while 6D4729 extracts only its 256-byte payload at offset 3.
  if (packet.length !== 259 && packet.length !== 261)
    throw new Error('Capabilities must contain 259 or 261 bytes');
  if (packet.length === 259) {
    // Restrict the checksum-free variant to the observed capabilities header.
    if (packet[0] !== 0x0e || packet[1] !== 3 || packet[2] !== 0)
      throw new Error('Unknown checksum-free capabilities header');
  } else if (packet.readUInt16LE(259) !== checksum(packet)) {
    throw new Error('Capabilities checksum mismatch');
  }
  const payload = packet.subarray(3, 259);
  // VA 7A78CE..7A78F3: LB1.00 selects PLU Type "No Limit"; older limits stop here.
  if (!payload.subarray(1, 7).equals(Buffer.from('LB1.00', 'ascii')))
    throw new Error(
      'Unknown capabilities: LB1.00 / No Limit PLU layout required',
    );
  // VA 7A780E and 7A7B28: zero retains the default 36, positive overrides it.
  if (payload[25] !== 0 && payload[25] !== 36)
    throw new Error('Only the 36-byte PLU name layout is supported');
  return {
    nameBytes: 36,
    fingerprint: 'LB1.00',
    pluType: 'unlimited',
    family: payload[8] === 0x50 ? 'LP' : 'LS', // VA 7A78FC..7A7920.
    headerHex: packet.subarray(0, 3).toString('hex'),
    responseBytes: packet.length,
    checksumStatus: packet.length === 259 ? 'not-provided' : 'verified',
    flags: {
      payload0: payload[0],
      payload7: payload[7],
      payload8: payload[8],
      payload9: payload[9],
      payload22: payload[22],
      payload23: payload[23],
      payload24: payload[24],
    },
  };
}
