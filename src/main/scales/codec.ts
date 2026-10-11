import type { CatalogProduct, ScaleDevice } from '../../shared/catalog';

const cp1251Decoder = new TextDecoder('windows-1251', { fatal: true });
const cp1251Bytes = new Map<string, number>();
for (let byte = 0x20; byte <= 0xff; byte++) {
  if (byte === 0x7f) continue;
  try {
    const character = cp1251Decoder.decode(Uint8Array.of(byte));
    if (!/[\p{C}]/u.test(character)) cp1251Bytes.set(character, byte);
  } catch {
    // Undefined code-page bytes must never become replacement characters.
  }
}

function nameBytes(product: CatalogProduct, device: ScaleDevice): Buffer {
  const source = product.scale_name?.trim() ? product.scale_name : product.name;
  if (/[\p{C}]/u.test(source))
    throw new Error(
      'Название содержит управляющие или неподдерживаемые символы',
    );
  const name = source.trim();
  if (!name) throw new Error('Не указано название для весов');
  let bytes: Buffer;
  if (device.nameEncoding === 'ascii') {
    if (!/^[\x20-\x7e]+$/.test(name))
      throw new Error('Для ASCII требуется название латиницей (scale_name)');
    bytes = Buffer.from(name, 'ascii');
  } else if (device.nameEncoding === 'windows-1251') {
    const encoded: number[] = [];
    for (const character of name) {
      const byte = cp1251Bytes.get(character);
      if (byte === undefined)
        throw new Error('Название содержит символы вне Windows-1251');
      encoded.push(byte);
    }
    bytes = Buffer.from(encoded);
    if (cp1251Decoder.decode(bytes) !== name)
      throw new Error('Название нельзя передать без потери символов');
  } else throw new Error('Не выбрана поддерживаемая кодировка названия');
  if (bytes.length > 36)
    throw new Error('Название для весов превышает 36 байт');
  return bytes;
}

function priceDigits(price: string | null): string {
  if (typeof price !== 'string' || !/^\d{1,12}(?:\.\d{1,2})?$/.test(price)) {
    throw new Error('Требуется положительная цена с точностью до двух знаков');
  }
  const [whole, fraction = ''] = price.split('.');
  const digits = (whole + fraction.padEnd(2, '0')).replace(/^0+/, '');
  if (!digits || digits.length > 8)
    throw new Error('Цена должна быть от 0.01 до 999999.99');
  return digits.padStart(8, '0');
}

function bcd(digits: string): Buffer {
  return Buffer.from(
    digits.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
  );
}

export function productIssues(
  product: CatalogProduct,
  device: ScaleDevice | null,
): string[] {
  const issues: string[] = [];
  if (product.unit !== 'kg')
    issues.push('Товар должен измеряться в килограммах');
  if (!product.is_active) issues.push('Товар неактивен');
  if (
    !Number.isInteger(product.scale_plu) ||
    product.scale_plu === null ||
    product.scale_plu < 1 ||
    product.scale_plu > 99999
  ) {
    issues.push('PLU должен быть целым числом от 1 до 99999');
  }
  try {
    priceDigits(product.retail_price);
  } catch (error) {
    issues.push((error as Error).message);
  }
  if (!device) {
    issues.push('Настройте весы перед загрузкой');
    return issues;
  }
  if (!device.setupConfirmed)
    issues.push('Подтвердите настройки кодировки, цены и штрихкода на весах');
  if (!/^\d{2}$/.test(device.barcodePrefix))
    issues.push('Префикс штрихкода должен содержать две цифры');
  try {
    nameBytes(product, device);
  } catch (error) {
    issues.push((error as Error).message);
  }
  return issues;
}

export function encodeCatalogProduct(
  product: CatalogProduct,
  device: ScaleDevice,
): Buffer {
  const issues = productIssues(product, device);
  if (issues.length) throw new Error(issues.join('; '));
  const packet = Buffer.alloc(261);
  packet[0] = 0x0b;
  const record = packet.subarray(3, 67);
  record.fill(0x20, 0, 36);
  nameBytes(product, device).copy(record, 0);
  const plu = String(product.scale_plu);
  bcd(plu.padStart(6, '0')).copy(record, 36);
  // Documented type 07 uses the department as prefix. The physical label and
  // code page still require confirmation on this device before setupConfirmed.
  record[41] = Number.parseInt(device.barcodePrefix, 16);
  record[42] = 7;
  bcd(priceDigits(product.retail_price)).copy(record, 43);
  record[47] = 4; // kg, no extra unit flags
  bcd(plu.padStart(10, '0')).copy(record, 59);
  packet.writeUInt16LE(
    packet.subarray(0, 259).reduce((sum, byte) => sum + byte, 0) & 0xffff,
    259,
  );
  return packet;
}
