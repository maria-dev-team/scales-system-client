import type { CheckResult } from '../../shared/diagnostics';

// First 261 bytes of the research PLU.USR (SHA-256 of original file:
// 9eaa66e3362744d52b7db39900cc852c352bc35ca8be5bf4e9d01e8f24ebbe72).
// An offline fixture only: this block must never be sent to a scale.
export const GOLDEN_PLU_HEX =
  '0b0000c6bbb9fb202020204150504c45202020202020202020202020202020202020202020202090000100000220000015000400000000000000000000000000900001cad6b0c7bca6cad6ccd7202020202020202020202020202020202020202020202020202090000200000220000015000400000000000000000000000000900002d0ecb8a3bcc7c9a2ccc7202020202020202020202020202020202020202020202020202090000300000220000015000400000000000000000000000000900003cfcabca6b5b028b4f329202020202020202020202020202020202020202020202020202090000400000220000015000400000000000000000000000000900004fe2c';

interface PluRecord {
  nameHex: string;
  lfCode: string;
  code: string;
  priceRaw: number;
  unit: number;
}

interface PluBlock {
  command: number;
  index: number;
  checksum: number;
  records: PluRecord[];
}

function bcd(bytes: Buffer): string {
  return [...bytes]
    .map((value) => {
      const hi = value >> 4;
      const lo = value & 15;
      if (hi > 9 || lo > 9) throw new Error('Invalid BCD digit');
      return `${hi}${lo}`;
    })
    .join('');
}

export function parsePluBlock(block: Buffer): PluBlock {
  if (block.length !== 261) throw new Error('PLU block must contain 261 bytes');
  const checksum =
    block.subarray(0, 259).reduce((sum, value) => sum + value, 0) & 0xffff;
  if (checksum !== block.readUInt16LE(259))
    throw new Error('PLU checksum mismatch');
  const records = Array.from({ length: 4 }, (_, index) => {
    const bytes = block.subarray(3 + index * 64, 3 + (index + 1) * 64);
    return {
      nameHex: bytes.subarray(0, 36).toString('hex'),
      lfCode: bcd(bytes.subarray(36, 39)),
      code: bcd(bytes.subarray(59, 64)),
      priceRaw: Number(bcd(bytes.subarray(43, 47))),
      unit: bytes[47] & 15,
    };
  });
  return { command: block[0], index: block.readUInt16LE(1), checksum, records };
}

export function checkPluFixture(): CheckResult {
  try {
    const fixture = Buffer.from(GOLDEN_PLU_HEX, 'hex');
    const parsed = parsePluBlock(fixture);
    const first = parsed.records[0];
    if (
      parsed.checksum !== 11518 ||
      parsed.command !== 11 ||
      parsed.index !== 0 ||
      first.lfCode !== '900001' ||
      first.code !== '0000900001' ||
      first.priceRaw !== 1500 ||
      first.unit !== 4
    ) {
      throw new Error(
        'Decoded fields differ from the independent research sample',
      );
    }
    const corrupted = Buffer.from(fixture);
    corrupted[10] ^= 1;
    let corruptionDetected = false;
    try {
      parsePluBlock(corrupted);
    } catch {
      corruptionDetected = true;
    }
    if (!corruptionDetected) throw new Error('Corrupt block was accepted');
    return {
      status: 'passed',
      summary:
        'Офлайн: 261 байт, 4 PLU, checksum 11518; повреждение обнаружено. Совместимость с весами не проверена.',
      details: {
        source: 'RLS1000 v1.129 PLU.USR, first block',
        ...parsed,
        corruptionDetected,
        priceInterpretation:
          '1500 is the raw BCD value; decimal places depend on scale settings',
        unitInterpretation:
          '4 is the observed unit nibble, not a verified unit mapping',
      },
    };
  } catch (cause) {
    return {
      status: 'failed',
      summary: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
