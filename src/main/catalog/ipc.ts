import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';

import type { CatalogRequest } from '../../shared/catalog';
import { parseProfile } from '../diagnostics/probes';
import { isTrustedRendererUrl } from '../diagnostics/trusted-renderer';
import type { CatalogService } from './service';

const deviceSchema = z
  .object({
    scaleIp: z.string().max(15),
    localAddress: z.string().max(15),
    port: z.number().int().min(1).max(65535),
    nameEncoding: z.enum(['ascii', 'windows-1251']),
    barcodePrefix: z.string().regex(/^\d{2}$/),
    setupConfirmed: z.boolean(),
  })
  .strict()
  .superRefine((device, context) => {
    try {
      parseProfile(device);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Некорректные параметры подключения к весам.',
      });
    }
  });
const productIds = z.array(z.string().uuid()).min(1).max(99999).optional();
const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state') }).strict(),
  z
    .object({
      type: z.literal('connect'),
      accessToken: z.string().min(1).max(16384),
    })
    .strict(),
  z.object({ type: z.literal('disconnect') }).strict(),
  z
    .object({
      type: z.literal('list'),
      search: z.string().max(512),
      offset: z.number().int().min(0).max(1_000_000),
    })
    .strict(),
  z.object({ type: z.literal('sync') }).strict(),
  z.object({ type: z.literal('cancel-sync') }).strict(),
  z.object({ type: z.literal('save-device'), device: deviceSchema }).strict(),
  z.object({ type: z.literal('preview'), productIds }).strict(),
  z
    .object({
      type: z.literal('upload'),
      productIds,
      confirmUncertain: z.boolean(),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ type: z.literal('cancel-upload') }).strict(),
  z.object({ type: z.literal('prepare-clear') }).strict(),
  z
    .object({ type: z.literal('clear-products'), token: z.string().uuid() })
    .strict(),
  z.object({ type: z.literal('cancel-clear') }).strict(),
  z.object({ type: z.literal('export-clear') }).strict(),
  z.object({ type: z.literal('adapters') }).strict(),
  z.object({ type: z.literal('export-upload') }).strict(),
]);

const operationLabels: Record<CatalogRequest['type'], string> = {
  state: 'Состояние каталога',
  connect: 'Подключение каталога',
  disconnect: 'Отключение каталога',
  list: 'Список товаров',
  sync: 'Обновление каталога',
  'cancel-sync': 'Остановка обновления каталога',
  'save-device': 'Сохранение подключения к весам',
  preview: 'Подготовка загрузки',
  upload: 'Загрузка товаров',
  'cancel-upload': 'Остановка загрузки',
  'prepare-clear': 'Подготовка очистки',
  'clear-products': 'Удаление товаров',
  'cancel-clear': 'Остановка очистки',
  'export-clear': 'Экспорт отчёта об очистке',
  adapters: 'Сетевые адаптеры',
  'export-upload': 'Экспорт отчёта о загрузке',
};
const fieldLabels: Record<string, string> = {
  accessToken: 'сеанс входа',
  search: 'поисковый запрос',
  offset: 'страница каталога',
  device: 'подключение к весам',
  'device.scaleIp': 'IP весов',
  'device.localAddress': 'адрес адаптера',
  'device.port': 'UDP-порт',
  'device.nameEncoding': 'кодировка названий',
  'device.barcodePrefix': 'префикс штрихкода',
  'device.setupConfirmed': 'проверка настройки весов',
  productIds: 'выбранные товары',
  confirmUncertain: 'разрешение повторной записи',
  revision: 'результат подготовки загрузки',
  token: 'подтверждение удаления',
};

function validationMessage(input: unknown, error: z.ZodError): string {
  const type =
    input && typeof input === 'object' && 'type' in input ? input.type : null;
  if (typeof type !== 'string' || !Object.hasOwn(operationLabels, type))
    return 'Операция каталога не поддерживается. Полностью закройте и снова откройте приложение.';
  const operation = type as CatalogRequest['type'];
  // Never reflect values, unknown commands or extra field names from the input.
  const fields = [
    ...new Set(
      error.issues.map((issue) => {
        const path = issue.path
          .filter((part) => typeof part === 'string')
          .join('.');
        return Object.hasOwn(fieldLabels, path)
          ? fieldLabels[path]
          : 'структура запроса';
      }),
    ),
  ].join(', ');
  const nextStep =
    operation === 'upload' || operation === 'preview'
      ? 'Подготовьте загрузку заново.'
      : operation === 'clear-products'
        ? 'Откройте подтверждение удаления заново.'
        : operation === 'save-device'
          ? 'Проверьте настройки подключения к весам.'
          : 'Полностью закройте и снова откройте приложение.';
  return `${operationLabels[operation]}: некорректные параметры — ${fields}. ${nextStep}`;
}

export function registerCatalogIpc(
  service: CatalogService,
  devUrl?: string,
): void {
  ipcMain.handle('catalog:request', async (event, input: unknown) => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame ||
      !isTrustedRendererUrl(event.senderFrame?.url ?? '', devUrl)
    )
      throw new Error('Источник запроса каталога не разрешён.');
    const result = requestSchema.safeParse(input);
    if (!result.success)
      throw new Error(validationMessage(input, result.error));
    return service.request(result.data);
  });
}
