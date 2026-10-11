// @vitest-environment node
import type { IpcMainInvokeEvent } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CatalogRequest, ClearPluJob } from '../../shared/catalog';
import { registerCatalogIpc } from './ipc';
import { CatalogService } from './service';

const harness = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
  >(),
  worker: null as EventEmitter | null,
  sent: [] as Array<{ id: number; request?: { type: string } }>,
  trusted: {} as object,
  exportDirectory: null as string | null,
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>,
    ) => harness.handlers.set(channel, handler),
  },
  BrowserWindow: {
    fromWebContents: (sender: object) =>
      sender === harness.trusted ? {} : null,
    getAllWindows: () => [],
  },
  dialog: {
    showOpenDialog: async () => ({
      canceled: !harness.exportDirectory,
      filePaths: harness.exportDirectory ? [harness.exportDirectory] : [],
    }),
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super();
        harness.worker = this;
      }
      postMessage(message: { id: number; request?: { type: string } }): void {
        harness.sent.push(message);
        if (message.request?.type === 'close')
          queueMicrotask(() =>
            this.emit('message', { id: message.id, ok: true, value: null }),
          );
      }
      async terminate(): Promise<number> {
        this.emit('exit', 0);
        return 0;
      }
    },
  };
});
const directories: string[] = [];
const services: CatalogService[] = [];
async function setup(): Promise<CatalogService> {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-ipc-'));
  directories.push(directory);
  const service = new CatalogService({
    dataDirectory: directory,
    apiUrl: 'https://api.test',
  });
  services.push(service);
  await service.initialize();
  return service;
}
const turn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
const event = (url = 'maria://app/'): IpcMainInvokeEvent => {
  const mainFrame = { url };
  Object.assign(harness.trusted, { mainFrame });
  return {
    sender: harness.trusted,
    senderFrame: mainFrame,
  } as IpcMainInvokeEvent;
};
beforeEach(() => {
  harness.handlers.clear();
  harness.sent.length = 0;
  harness.worker = null;
  harness.exportDirectory = null;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('rejects untrusted frames before dispatching work', async () => {
  const service = await setup();
  registerCatalogIpc(service);
  const handle = harness.handlers.get('catalog:request')!;
  await expect(
    handle(event('https://evil.test'), { type: 'state' }),
  ).rejects.toThrow();
  const child = event();
  Object.assign(child, { senderFrame: { url: 'maria://app/' } });
  await expect(handle(child, { type: 'state' })).rejects.toThrow();
  expect(harness.sent).toEqual([]);
});

it('rejects arbitrary paths, oversized selections and invalid network parameters at IPC', async () => {
  const service = await setup();
  registerCatalogIpc(service);
  const handle = harness.handlers.get('catalog:request')!;
  for (const request of [
    { type: 'state', sql: 'DROP TABLE products' },
    { type: 'list', search: '', offset: -1 },
    { type: 'connect', accessToken: '' },
    { type: 'clear-products', token: '' },
    {
      type: 'clear-products',
      token: '00000000-0000-4000-8000-000000000001',
      scaleIp: '192.168.1.8',
    },
    {
      type: 'preview',
      productIds: Array(100_001).fill('00000000-0000-4000-8000-000000000001'),
    },
    {
      type: 'save-device',
      device: {
        scaleIp: '127.0.0.1',
        localAddress: '192.168.1.2',
        port: 5000,
        nameEncoding: 'ascii',
        barcodePrefix: '21',
        setupConfirmed: true,
      },
    },
  ])
    await expect(handle(event(), request)).rejects.toThrow();
  expect(harness.sent).toEqual([]);
});

const uploadRequest: CatalogRequest = {
  type: 'upload',
  confirmUncertain: false,
  revision: '0'.repeat(64),
};
const clearRequest: CatalogRequest = {
  type: 'clear-products',
  token: '00000000-0000-4000-8000-000000000001',
};

it('accepts the prepare/confirm clear and preview/upload payloads used by the renderer', async () => {
  const service = await setup();
  const dispatch = vi.spyOn(service, 'request').mockResolvedValue(null);
  registerCatalogIpc(service);
  const handle = harness.handlers.get('catalog:request')!;
  const token = randomUUID();
  const revision = createHash('sha256').update('catalog-preview').digest('hex');
  const productIds = [randomUUID(), randomUUID()];
  const requests: CatalogRequest[] = [
    { type: 'prepare-clear' },
    { type: 'clear-products', token },
    { type: 'cancel-clear' },
    { type: 'export-clear' },
    { type: 'preview' },
    { type: 'upload', revision, confirmUncertain: false },
    { type: 'preview', productIds },
    { type: 'upload', revision, productIds, confirmUncertain: true },
  ];
  for (const request of requests) {
    await handle(event(), structuredClone(request));
    expect(dispatch).toHaveBeenLastCalledWith(request);
  }
});

it.each([
  [
    { type: 'upload', confirmUncertain: false },
    ['Загрузка товаров', 'результат подготовки загрузки'],
  ],
  [
    { type: 'clear-products', token: 'private-invalid-token' },
    ['Удаление товаров', 'подтверждение удаления'],
  ],
  [
    { type: 'preview', productIds: ['private-invalid-product-id'] },
    ['Подготовка загрузки', 'выбранные товары'],
  ],
  [
    { type: 'connect', accessToken: '' },
    ['Подключение каталога', 'сеанс входа'],
  ],
])(
  'reports the known operation and invalid field for %j without dispatching',
  async (request, details) => {
    const service = await setup();
    registerCatalogIpc(service);
    const handle = harness.handlers.get('catalog:request')!;
    const error = await handle(event(), request).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    for (const detail of details)
      expect((error as Error).message).toContain(detail);
    expect((error as Error).message).not.toContain('private-');
    expect(harness.sent).toEqual([]);
  },
);

it('never reflects unknown commands or extra field names in validation errors', async () => {
  const service = await setup();
  registerCatalogIpc(service);
  const handle = harness.handlers.get('catalog:request')!;
  for (const request of [
    { type: 'private-command-value' },
    { type: 'prepare-clear', 'private-field-name': 'private-secret-value' },
  ]) {
    const error = await handle(event(), request).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('private-');
  }
  expect(harness.sent).toEqual([]);
});

it('explains how to recover from an unknown operation without guessing compatibility', async () => {
  const service = await setup();
  registerCatalogIpc(service);
  const handle = harness.handlers.get('catalog:request')!;
  await expect(
    handle(event(), { type: 'newer-renderer-command' }),
  ).rejects.toThrow(
    'Операция каталога не поддерживается. Полностью закройте и снова откройте приложение.',
  );
  expect(harness.sent).toEqual([]);
});
it.each([
  [uploadRequest, uploadRequest],
  [clearRequest, clearRequest],
  [uploadRequest, clearRequest],
  [clearRequest, uploadRequest],
])(
  'reserves device exclusivity for %j before accepting %j',
  async (first, second) => {
    const service = await setup();
    const request = service.request(first);
    expect(service.isUploading()).toBe(true);
    await expect(service.request(second)).rejects.toThrow();
    await turn();
    harness.worker!.emit('message', { type: 'changed', uploading: false });
    expect(service.isUploading()).toBe(true);
    const sent = harness.sent.find(
      (message) => message.request?.type === first.type,
    )!;
    harness.worker!.emit('message', {
      id: sent.id,
      ok: false,
      message: 'Device not configured',
    });
    await expect(request).rejects.toThrow('Device not configured');
    expect(service.isUploading()).toBe(false);
  },
);

it('releases pending calls on worker failure', async () => {
  const service = await setup();
  const request = service.request({ type: 'connect', accessToken: 'secret' });
  await turn();
  harness.worker!.emit('error', new Error('worker crashed'));
  await expect(request).rejects.toThrow();
  expect((await service.request({ type: 'state' })).error).toBeTruthy();
});

it('surfaces local initialization failure through catalog state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-error-'));
  directories.push(directory);
  const file = join(directory, 'not-a-directory');
  await writeFile(file, 'occupied');
  const service = new CatalogService({
    dataDirectory: file,
    apiUrl: 'https://api.test',
  });
  services.push(service);
  await expect(service.initialize()).resolves.toBeUndefined();
  expect((await service.request({ type: 'state' })).error).toBeTruthy();
  await expect(service.request({ type: 'sync' })).rejects.toThrow();
});

it('accepts worker readiness and reports malformed grant persistence without crashing main', async () => {
  await setup();
  expect(() =>
    harness.worker!.emit('message', { type: 'ready' }),
  ).not.toThrow();
  expect(() =>
    harness.worker!.emit('message', {
      type: 'persist-grant',
      id: 99,
      grant: undefined,
    }),
  ).not.toThrow();
  await turn();
  expect(harness.sent).toContainEqual(
    expect.objectContaining({ type: 'grant-result', id: 99, ok: false }),
  );
});

it('exports an uncertain clear with raw exchange evidence and without access identity', async () => {
  const service = await setup();
  harness.exportDirectory = directories.at(-1)!;
  const job: ClearPluJob = {
    id: 'clear-job',
    scope: {
      apiUrl: 'https://api.private.test',
      userId: 'private-user',
      membershipId: 'private-membership',
      organizationId: 'organization',
      storeId: 'store',
      storeName: 'Shop',
    },
    device: {
      scaleIp: '192.168.1.8',
      localAddress: '192.168.1.2',
      port: 5001,
      nameEncoding: 'ascii',
      barcodePrefix: '21',
      setupConfirmed: false,
    },
    createdAt: '2026-10-11T10:00:00.000Z',
    finishedAt: '2026-10-11T10:01:00.000Z',
    status: 'failed',
    commandState: 'uncertain',
    events: [
      {
        at: '2026-10-11T10:00:01.000Z',
        kind: 'rx',
        phase: 'clear:extended',
        hex: '02',
      },
      {
        at: '2026-10-11T10:00:02.000Z',
        kind: 'tx',
        phase: 'clear:base:planned',
        hex: '0e04000002ff0200',
      },
    ],
    error: 'Нет ответа весов (clear:base)',
    disconnectError: 'Нет ответа весов (disconnect)',
  };
  const exported = service.request({ type: 'export-clear' });
  await turn();
  const sent = harness.sent.find(
    (message) => message.request?.type === 'export-clear',
  )!;
  harness.worker!.emit('message', { id: sent.id, ok: true, value: job });
  const path = await exported;
  expect(path).toContain('scales-clear-');
  const json = JSON.parse(await readFile(join(path!, 'report.json'), 'utf8'));
  expect(json).toMatchObject({
    operation: 'clear',
    status: 'failed',
    commandState: 'uncertain',
    events: job.events,
    error: job.error,
    disconnectError: job.disconnectError,
    device: job.device,
  });
  expect(json.scope).toEqual({
    organizationId: 'organization',
    storeId: 'store',
    storeName: 'Shop',
  });
  const report = await readFile(join(path!, 'report.txt'), 'utf8');
  expect(report).toContain('Результат очистки: uncertain');
  expect(report).toContain('clear:base:planned tx 0e04000002ff0200');
  expect(report).toContain(job.error);
  expect(report).not.toContain('private-user');
});
