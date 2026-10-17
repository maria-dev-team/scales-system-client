// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { CatalogProduct, ScaleDevice } from '../../shared/catalog';
import { encodeCatalogProduct, productIssues } from './codec';

const device: ScaleDevice = {
  scaleIp: '192.168.1.87',
  port: 5001,
  localAddress: '192.168.1.89',
  nameEncoding: 'ascii',
  barcodePrefix: '22',
  setupConfirmed: true,
};
const product: CatalogProduct = {
  id: 'product-1',
  organization_id: 'org-1',
  store_id: 'store-1',
  name: 'APPLE',
  scale_name: null,
  scale_plu: 12345,
  barcode: '',
  unit: 'kg',
  retail_price: '12.34',
  is_active: true,
  updated_at: '2026-10-11T00:00:00Z',
};

describe('catalog PLU encoding', () => {
  it.each([
    ['05', '05'],
    ['27', '27'],
  ])(
    'preserves prefix %s and the backend PLU while ignoring an ordinary UMAG barcode',
    (prefix, department) => {
      const packet = encodeCatalogProduct(
        { ...product, barcode: '2763189', scale_plu: 4245 },
        { ...device, barcodePrefix: prefix },
      );
      expect(packet.subarray(39, 42).toString('hex')).toBe('004245');
      expect(packet.subarray(62, 67).toString('hex')).toBe('0000004245');
      expect(packet.subarray(44, 46).toString('hex')).toBe(`${department}07`);
      expect(packet.subarray(46, 51).toString('hex')).toBe('0000123404');
    },
  );

  it('does not silently replace an explicitly empty scale name with the product name', () => {
    expect(() =>
      encodeCatalogProduct({ ...product, scale_name: '' }, device),
    ).toThrow('название');
  });

  it('writes one PLU with separate prefix, type 07, exact price and zero unused slots', () => {
    const packet = encodeCatalogProduct(product, device);
    expect(packet.length).toBe(261);
    expect(packet.subarray(0, 3).toString('hex')).toBe('0b0000');
    expect(packet.subarray(3, 39).toString('ascii')).toBe(
      'APPLE' + ' '.repeat(31),
    );
    expect(packet.subarray(39, 67).toString('hex')).toBe(
      '01234500002207000012340400000000000000000000000000012345',
    );
    expect(packet.subarray(67, 259).equals(Buffer.alloc(192))).toBe(true);
    expect(packet.readUInt16LE(259)).toBe(1698);
  });

  it('uses explicit scale name and encodes supported Cyrillic without lossy replacement', () => {
    const packet = encodeCatalogProduct(
      { ...product, name: 'Fallback', scale_name: ' Яблоко ЁЖ й ' },
      { ...device, nameEncoding: 'windows-1251' },
    );
    expect(packet.subarray(3, 14).toString('hex')).toBe(
      'dfe1ebeeeaee20a8c620e9',
    );
    expect(packet.subarray(14, 39).equals(Buffer.alloc(25, 0x20))).toBe(true);
  });

  it.each([
    ['0.01', '00000001'],
    ['12', '00001200'],
    ['12.3', '00001230'],
    ['999999.99', '99999999'],
    ['00012.34', '00001234'],
    ['0.29', '00000029'],
    ['1.15', '00000115'],
  ])('preserves exact decimal price %s', (price, expected) => {
    expect(
      encodeCatalogProduct({ ...product, retail_price: price }, device)
        .subarray(46, 50)
        .toString('hex'),
    ).toBe(expected);
  });

  it.each([null, '0', '-1', '1.001', '1e2', '1000000', 'NaN', '12,34'])(
    'blocks invalid or unrepresentable price %s',
    (price) => {
      expect(
        productIssues({ ...product, retail_price: price }, device).length,
      ).toBeGreaterThan(0);
      expect(() =>
        encodeCatalogProduct({ ...product, retail_price: price }, device),
      ).toThrow();
    },
  );

  it.each([
    { scale_plu: null },
    { scale_plu: 0 },
    { scale_plu: 100000 },
    { scale_plu: 1.5 },
    { is_active: false },
    { name: '' },
    { name: 'A'.repeat(37) },
    { name: 'Яблоко' },
    { name: 'APPLE\n' },
    { name: 'APPLE\u0000' },
  ])('excludes unsafe product %j before creating a packet', (change) => {
    expect(
      productIssues({ ...product, ...change }, device).length,
    ).toBeGreaterThan(0);
    expect(() =>
      encodeCatalogProduct({ ...product, ...change }, device),
    ).toThrow();
  });

  it.each([
    [1, '000001', '0000000001'],
    [99999, '099999', '0000099999'],
  ] as const)(
    'preserves boundary PLU %s in both identity fields',
    (plu, lf, code) => {
      const packet = encodeCatalogProduct(
        { ...product, scale_plu: plu },
        device,
      );
      expect(packet.subarray(39, 42).toString('hex')).toBe(lf);
      expect(packet.subarray(62, 67).toString('hex')).toBe(code);
    },
  );

  it('validates runtime units, prefix and all 36 CP1251 bytes', () => {
    const cyrillic = { ...device, nameEncoding: 'windows-1251' as const };
    expect(
      encodeCatalogProduct(
        { ...product, name: 'Я'.repeat(36) },
        cyrillic,
      ).subarray(3, 39),
    ).toEqual(Buffer.alloc(36, 0xdf));
    for (const name of ['Я'.repeat(37), '\ufffd', '\u0085']) {
      expect(() =>
        encodeCatalogProduct({ ...product, name }, cyrillic),
      ).toThrow();
    }
    expect(() =>
      encodeCatalogProduct({ ...product, unit: 'pcs' as 'kg' }, device),
    ).toThrow();
    expect(() =>
      encodeCatalogProduct(product, { ...device, barcodePrefix: '2x' }),
    ).toThrow();
    expect(() =>
      encodeCatalogProduct(product, { ...device, barcodePrefix: '27\n' }),
    ).toThrow();
  });

  it('rejects unconfirmed setup and unsupported CP1251 characters', () => {
    expect(productIssues(product, null).length).toBeGreaterThan(0);
    expect(() =>
      encodeCatalogProduct(product, { ...device, setupConfirmed: false }),
    ).toThrow();
    expect(() =>
      encodeCatalogProduct(
        { ...product, name: 'Қант' },
        {
          ...device,
          nameEncoding: 'windows-1251',
        },
      ),
    ).toThrow();
  });
});
