// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { GOLDEN_PLU_HEX, checkPluFixture, parsePluBlock } from './plu';

describe('RLS1000 research fixture', () => {
  it('decodes the independently captured first PLU.USR block', () => {
    const block = Buffer.from(GOLDEN_PLU_HEX, 'hex');
    expect(block.length).toBe(261);
    const parsed = parsePluBlock(block);
    expect(parsed.checksum).toBe(11518);
    expect(parsed.command).toBe(11);
    expect(parsed.index).toBe(0);
    expect(parsed.records).toHaveLength(4);
    expect(parsed.records[0]).toMatchObject({
      lfCode: '900001',
      code: '0000900001',
      priceRaw: 1500,
      unit: 4,
    });
    expect(checkPluFixture().status).toBe('passed');
  });

  it('rejects a corrupt block without recalculating its reference checksum', () => {
    const block = Buffer.from(GOLDEN_PLU_HEX, 'hex');
    block[10] ^= 1;
    expect(() => parsePluBlock(block)).toThrow(/checksum/i);
  });

  it('rejects incomplete and oversized blocks', () => {
    expect(() => parsePluBlock(Buffer.alloc(260))).toThrow(/261/);
    expect(() => parsePluBlock(Buffer.alloc(262))).toThrow(/261/);
  });

  it('rejects invalid BCD even when checksum matches', () => {
    const block = Buffer.from(GOLDEN_PLU_HEX, 'hex');
    block[39] = 0xfa;
    block.writeUInt16LE(
      block.subarray(0, 259).reduce((sum, value) => sum + value, 0) & 0xffff,
      259,
    );
    expect(() => parsePluBlock(block)).toThrow(/BCD/);
  });
});
