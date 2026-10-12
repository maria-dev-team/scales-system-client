import { BrowserWindow, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { emptyCatalogState } from '../../shared/catalog';
import type {
  CatalogRequest,
  CatalogResultMap,
  ClearPluJob,
  UploadJob,
} from '../../shared/catalog';
import type { CatalogGrant } from './access';
import { CatalogGrantStore } from './grant-store';

type WorkerMessage =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string }
  | { type: 'changed'; uploading: boolean }
  | { type: 'refresh-required' }
  | { type: 'ready' }
  | { type: 'persist-grant'; id: number; grant: CatalogGrant | null };
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class CatalogService {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  private failure: Error | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private uploadReserved = false;
  private workerUploading = false;
  private readonly grantStore: CatalogGrantStore;

  constructor(
    private readonly options: {
      dataDirectory: string;
      apiUrl: string;
    },
  ) {
    this.grantStore = new CatalogGrantStore(
      join(options.dataDirectory, 'catalog'),
    );
  }
  initialize(): Promise<void> {
    this.ready ??= this.start().catch(() => {
      this.fail(
        new Error(
          'Локальное хранилище каталога недоступно. Перезапустите приложение и проверьте свободное место.',
        ),
      );
    });
    return this.ready;
  }
  private async start(): Promise<void> {
    const directory = join(this.options.dataDirectory, 'catalog');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const grant = await this.grantStore.load();
    if (this.closed) return;
    const worker = new Worker(join(__dirname, 'catalog-worker.js'), {
      workerData: {
        databasePath: join(directory, 'catalog.sqlite'),
        apiUrl: this.options.apiUrl,
        grant,
      },
    });
    this.worker = worker;
    worker.on('error', () =>
      this.fail(
        new Error(
          'Локальный процесс каталога завершился с ошибкой. Перезапустите приложение; не удаляйте локальную базу.',
        ),
      ),
    );
    worker.on('exit', () =>
      this.fail(
        new Error(
          'Локальный процесс каталога завершился. Перезапустите приложение.',
        ),
      ),
    );
    worker.on('message', (message: WorkerMessage) => this.receive(message));
  }
  private notify(channel: string): void {
    if (this.closed) return;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel);
    }
  }
  private fail(error: Error): void {
    this.failure = error;
    this.uploadReserved = false;
    this.workerUploading = false;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.notify('catalog:changed');
  }
  private receive(message: WorkerMessage): void {
    if ('type' in message) {
      if (message.type === 'changed') {
        this.workerUploading = message.uploading;
        this.notify('catalog:changed');
      } else if (message.type === 'refresh-required') {
        this.notify('catalog:refresh-required');
      } else if (message.type === 'ready') {
        this.notify('catalog:changed');
      } else if (message.type === 'persist-grant') {
        void Promise.resolve()
          .then(() => this.grantStore.save(message.grant))
          .then(
            (value) =>
              this.worker?.postMessage({
                type: 'grant-result',
                id: message.id,
                ok: true,
                value,
              }),
            () =>
              this.worker?.postMessage({
                type: 'grant-result',
                id: message.id,
                ok: false,
                message: 'Не удалось сохранить защищённый локальный доступ.',
              }),
          )
          .catch(() =>
            this.fail(
              new Error(
                'Не удалось подтвердить сохранение локального доступа.',
              ),
            ),
          );
      }
      return;
    }
    const entry = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.ok) entry?.resolve(message.value);
    else entry?.reject(new Error(message.message));
  }
  isUploading(): boolean {
    return this.uploadReserved || this.workerUploading;
  }
  private post(request: CatalogRequest | { type: 'close' }): Promise<unknown> {
    if (!this.worker || this.failure)
      return Promise.reject(
        this.failure ?? new Error('Локальный каталог недоступен.'),
      );
    if (this.pending.size >= 512)
      return Promise.reject(
        new Error('Слишком много запросов к локальному каталогу.'),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      if (request.type === 'state')
        timer = setTimeout(() => {
          this.pending
            .get(id)
            ?.reject(
              new Error(
                'Локальный процесс не ответил за 5 секунд. Статус неизвестен; повторите проверку.',
              ),
            );
        }, 5000);
      try {
        this.worker!.postMessage({ id, request });
      } catch {
        this.pending
          .get(id)
          ?.reject(
            new Error('Не удалось передать запрос локальному процессу.'),
          );
      }
    });
  }
  async request<T extends CatalogRequest>(
    input: T,
  ): Promise<CatalogResultMap[T['type']]> {
    if (this.closed) throw new Error('Приложение завершает работу.');
    const writesDevice =
      input.type === 'upload' || input.type === 'clear-products';
    if (writesDevice) {
      if (this.isUploading())
        throw new Error('Другая операция с весами уже выполняется.');
      this.uploadReserved = true;
    }
    try {
      await this.initialize();
      if (this.failure && input.type === 'state')
        return {
          ...emptyCatalogState(),
          error: this.failure.message,
        } as CatalogResultMap[T['type']];
      if (this.closed) throw new Error('Приложение завершает работу.');
      if (input.type === 'export-upload')
        return (await this.exportReport(
          'upload',
        )) as CatalogResultMap[T['type']];
      if (input.type === 'export-clear')
        return (await this.exportReport(
          'clear',
        )) as CatalogResultMap[T['type']];
      return (await this.post(input)) as CatalogResultMap[T['type']];
    } finally {
      if (writesDevice) this.uploadReserved = false;
    }
  }
  private async exportReport(kind: 'upload' | 'clear'): Promise<string | null> {
    const job = (await this.post({
      type: kind === 'clear' ? 'export-clear' : 'export-upload',
    })) as UploadJob | ClearPluJob | null;
    if (!job) throw new Error('Отчёт об операции ещё не создан.');
    const upload = 'items' in job ? job : null;
    const clear = 'commandState' in job ? job : null;
    const choice = await dialog.showOpenDialog({
      title: 'Выберите папку для отчёта операции',
      buttonLabel: 'Сохранить отчёт здесь',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const directory = join(
      choice.filePaths[0],
      `scales-${kind}-${randomUUID()}`,
    );
    await mkdir(directory, { recursive: false });
    const report = {
      id: job.id,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      status: job.status,
      operation: kind,
      ...(upload
        ? { catalogSyncedAt: upload.catalogSyncedAt, items: upload.items }
        : {}),
      ...(clear ? { commandState: clear.commandState } : {}),
      scope: {
        organizationId: job.scope.organizationId,
        storeId: job.scope.storeId,
        storeName: job.scope.storeName,
      },
      device: job.device,
      events: job.events,
      error: job.error,
      disconnectError: job.disconnectError,
    };
    const lines = [
      `DukenAI Scales — ${clear ? 'очистка товаров' : 'отправка каталога'} RLS1100`,
      `ID: ${job.id}`,
      `Магазин: ${job.scope.storeName}`,
      `Начало: ${job.createdAt}`,
      `Окончание: ${job.finishedAt ?? 'выполняется'}`,
      `Состояние: ${job.status}`,
      ...(upload
        ? [`Каталог актуален на: ${upload.catalogSyncedAt}`]
        : [`Результат очистки: ${clear!.commandState}`]),
      `Весы: ${job.device.scaleIp}:${job.device.port}`,
      `Ошибка: ${job.error ?? 'нет'}`,
      `Ошибка завершения сеанса: ${job.disconnectError ?? 'нет'}`,
      clear
        ? 'ACK подтверждает команды очистки; отсутствие старых PLU проверяется на весах. Остановка после отправки не отменяет удаление.'
        : 'ACK подтверждает приём пакета; наличие товара и печать проверяются на весах.',
      '',
      ...(upload?.items ?? []).flatMap((item) => [
        `[${item.state}] PLU ${item.product.scale_plu ?? '—'} ${item.product.name}; цена ${item.product.retail_price ?? '—'}`,
        `Ошибка: ${item.error ?? 'нет'}`,
        `TX PLU: ${item.packetHex}`,
      ]),
      '',
      ...job.events.map(
        (event) =>
          `${event.at} ${event.phase} ${event.kind} ${event.hex ?? ''} ${event.message ?? ''}`,
      ),
    ];
    await writeFile(
      join(directory, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      join(directory, 'report.txt'),
      `${lines.join('\n')}\n`,
      'utf8',
    );
    return directory;
  }
  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }
  private async stop(): Promise<void> {
    this.closed = true;
    await this.ready;
    if (!this.worker) return;
    try {
      if (!this.failure) await this.post({ type: 'close' });
    } finally {
      await this.worker.terminate();
      this.worker = null;
      this.fail(new Error('Локальный каталог закрыт.'));
    }
  }
}
