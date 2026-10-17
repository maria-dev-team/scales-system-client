export function encodeWeightedLabel(
  prefix: string,
  plu: number,
  grams: number,
): string {
  if (
    typeof prefix !== 'string' ||
    prefix.length !== 2 ||
    !/^\d{2}$/.test(prefix)
  )
    throw new Error('Префикс должен содержать ровно две цифры.');
  if (!Number.isSafeInteger(plu) || plu < 1 || plu > 99999)
    throw new Error('PLU должен быть целым числом от 1 до 99999.');
  if (!Number.isSafeInteger(grams) || grams < 1 || grams > 99999)
    throw new Error('Вес должен быть целым числом граммов от 1 до 99999.');
  const payload = `${prefix}${String(plu).padStart(5, '0')}${String(grams).padStart(5, '0')}`;
  let sum = 0;
  for (let i = 0; i < payload.length; i++)
    sum += Number(payload[i]) * (i % 2 === 0 ? 1 : 3);
  return `${payload}${(10 - (sum % 10)) % 10}`;
}
