import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { encodeWeightedLabel } from './weighted-label';

const fixture = JSON.parse(
  readFileSync(resolve('test/fixtures/ean13-weight-v1.json'), 'utf8'),
) as {
  prefix: string;
  valid: { barcode: string; scalePlu: number; quantity: string }[];
};

describe('expected ean13-weight-v1 label', () => {
  it.each(fixture.valid)(
    'matches the backend fixture $barcode for $quantity kg',
    ({ barcode, scalePlu, quantity }) => {
      const [kilograms, fraction = ''] = quantity.split('.');
      const grams = Number(`${kilograms}${fraction.padEnd(3, '0')}`);
      expect(encodeWeightedLabel(fixture.prefix, scalePlu, grams)).toBe(
        barcode,
      );
    },
  );

  it.each([
    ['27', '2704245001850'],
    ['05', '0504245001858'],
  ])('preserves prefix %s and five-digit fields', (prefix, expected) => {
    expect(encodeWeightedLabel(prefix, 4245, 185)).toBe(expected);
  });

  it.each(['', '2', '270', 'ab', ' 27', '٢٧', '27\n'])(
    'rejects invalid prefix %j',
    (prefix) => {
      expect(() => encodeWeightedLabel(prefix, 1, 185)).toThrow();
    },
  );

  it.each([0, -1, 100000, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid PLU or grams %s',
    (value) => {
      expect(() => encodeWeightedLabel('27', value, 185)).toThrow();
      expect(() => encodeWeightedLabel('27', 4245, value)).toThrow();
    },
  );
});
