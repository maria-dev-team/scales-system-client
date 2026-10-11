import { createHash, randomUUID } from 'node:crypto';

import { emptyCatalogState } from '../../shared/catalog';
import type {
  CatalogRequest,
  CatalogScope,
  CatalogState,
  ClearPluConfirmation,
  ClearPluJob,
  ScaleDevice,
  UploadJob,
  UploadPreview,
} from '../../shared/catalog';
import {
  checkSubnet,
  getNetworkAdapters,
  validateProfile,
} from '../diagnostics/probes';
import { runClearPlu } from '../scales/clear';
import { encodeCatalogProduct, productIssues } from '../scales/codec';
import { runUpload } from '../scales/upload';
import { grantIsValid, issueGrant, parseVerifiedScope } from './access';
import type { CatalogGrant } from './access';
import { CatalogApiError, requestCatalogApi } from './api';
import { CatalogDatabase, scopeKey } from './database';
import { CatalogSync } from './sync';

type Options = {
  apiUrl: string;
  grant?: CatalogGrant | null;
  persistGrant: (grant: CatalogGrant | null) => Promise<boolean>;
  fetcher?: typeof fetch;
  changed?: () => void;
  refreshRequired?: () => void;
  runUpload?: typeof runUpload;
  runClearPlu?: typeof runClearPlu;
};
const message = (error: unknown): string =>
  error instanceof Error ? error.message : 'Не удалось выполнить действие.';

/** Lives in the worker; only verified server context can select a database scope. */
export class CatalogEngine {
  private grant: CatalogGrant | null = null;
  private token: string | null = null;
  private online = false;
  private epoch = 0;
  private error: string | null = null;
  private storageWarning: string | null = null;
  private closed = false;
  private refreshRequested = false;
  private readonly connections = new Set<Promise<void>>();
  private connecting: AbortController | null = null;
  private syncing: AbortController | null = null;
  private uploading: AbortController | null = null;
  private syncTask: Promise<void> | null = null;
  private uploadTask: Promise<void> | null = null;
  private activeJob: UploadJob | null = null;
  private clearing: AbortController | null = null;
  private clearTask: Promise<void> | null = null;
  private activeClear: ClearPluJob | null = null;
  private clearConfirmation: (ClearPluConfirmation & { scope: string }) | null =
    null;
  private readonly sync: CatalogSync;
  private nextSyncAt = 0;
  private syncPaused = false;

  constructor(
    private readonly db: CatalogDatabase,
    private readonly options: Options,
  ) {
    if (grantIsValid(options.grant, options.apiUrl)) this.grant = options.grant;
    this.sync = new CatalogSync(
      db,
      (path, signal) => {
        const token = this.token;
        if (!token)
          throw new Error('Для обновления каталога нужен вход в Maria.');
        return requestCatalogApi(
          options.apiUrl,
          token,
          path,
          signal,
          options.fetcher,
        );
      },
      { changed: () => this.changed() },
    );
  }

  private changed(): void {
    if (!this.closed) this.options.changed?.();
  }
  private requestRefresh(): void {
    this.token = null;
    if (this.refreshRequested || this.closed) return;
    this.refreshRequested = true;
    this.options.refreshRequired?.();
  }
  isUploading(): boolean {
    return this.uploading !== null || this.clearing !== null;
  }

  private assertAccess(): CatalogScope {
    if (!grantIsValid(this.grant, this.options.apiUrl)) {
      this.token = null;
      this.grant = null;
      this.syncing?.abort();
      this.uploading?.abort();
      this.clearing?.abort();
      this.clearConfirmation = null;
      throw new Error(
        'Локальный доступ истёк. Подключитесь к интернету и войдите в Maria.',
      );
    }
    return this.grant.scope;
  }

  state(): CatalogState {
    if (this.closed) return emptyCatalogState();
    if (!this.grant) return { ...emptyCatalogState(), error: this.error };
    try {
      this.assertAccess();
    } catch (error) {
      return { ...emptyCatalogState(), error: message(error) };
    }
    const scope = this.grant!.scope;
    const stored = this.db.getState(scope);
    return {
      ...emptyCatalogState(),
      ...stored,
      scope,
      sync: { ...stored.sync, running: this.syncing !== null },
      profile: this.db.getProgress(scope)?.profile ?? stored.profile,
      access: this.online ? 'online' : 'offline',
      accessExpiresAt: new Date(this.grant!.expiresAt).toISOString(),
      device: this.db.getDevice(scope),
      latestUpload:
        this.activeJob?.scope &&
        scopeKey(this.activeJob.scope) === scopeKey(scope)
          ? structuredClone(this.activeJob)
          : this.db.getLatestUpload(scope),
      latestClear:
        this.activeClear && scopeKey(this.activeClear.scope) === scopeKey(scope)
          ? structuredClone(this.activeClear)
          : this.db.getLatestClear(scope),
      error: this.error ?? this.storageWarning,
    };
  }

  private async disconnect(): Promise<void> {
    this.epoch++;
    this.connecting?.abort();
    this.syncing?.abort();
    this.uploading?.abort();
    this.clearing?.abort();
    this.clearConfirmation = null;
    this.token = null;
    this.grant = null;
    this.online = false;
    this.error = null;
    this.storageWarning = null;
    this.refreshRequested = false;
    await this.options.persistGrant(null);
    this.changed();
  }

  private async connect(token: string): Promise<void> {
    this.connecting?.abort();
    const controller = new AbortController();
    this.connecting = controller;
    const epoch = this.epoch;
    const request = (path: string): Promise<unknown> =>
      requestCatalogApi(
        this.options.apiUrl,
        token,
        path,
        controller.signal,
        this.options.fetcher,
      );
    try {
      const user = await request('/v1/users/me');
      const context = await request('/v1/auth/context');
      let scope: CatalogScope;
      try {
        scope = parseVerifiedScope(this.options.apiUrl, user, context);
      } catch {
        throw new CatalogApiError(
          403,
          'CONTEXT_UNAVAILABLE',
          'Магазин или членство больше недоступны. Выберите контекст заново.',
        );
      }
      // The endpoint applies the complete backend permission policy, including implied read rights.
      await request('/v1/pos/catalog/sync-start?unit=kg');
      controller.signal.throwIfAborted();
      if (epoch !== this.epoch) throw new Error('Учётная запись изменилась.');
      if (this.grant && scopeKey(this.grant.scope) !== scopeKey(scope)) {
        this.syncing?.abort();
        this.uploading?.abort();
        this.clearing?.abort();
        this.clearConfirmation = null;
        await Promise.allSettled([
          this.syncTask,
          this.uploadTask,
          this.clearTask,
        ]);
      }
      controller.signal.throwIfAborted();
      if (epoch !== this.epoch) throw new Error('Учётная запись изменилась.');
      const grant = issueGrant(scope);
      const persisted = await this.options.persistGrant(grant);
      controller.signal.throwIfAborted();
      if (epoch !== this.epoch) throw new Error('Учётная запись изменилась.');
      this.grant = grant;
      this.token = token;
      this.online = true;
      this.refreshRequested = false;
      this.error = null;
      this.storageWarning = persisted
        ? null
        : 'Защищённое хранилище недоступно: офлайн-вход после перезапуска не сохранён.';
      this.changed();
      this.syncPaused = false;
      this.startSync();
    } catch (error) {
      if (!controller.signal.aborted && epoch === this.epoch) {
        if (error instanceof CatalogApiError && error.status === 403)
          await this.disconnect();
        else if (error instanceof CatalogApiError && error.status === 401)
          this.requestRefresh();
        this.online = false;
        this.error = message(error);
        this.changed();
      }
      throw error;
    } finally {
      if (this.connecting === controller) this.connecting = null;
    }
  }

  private startSync(): void {
    const scope = this.assertAccess();
    if (this.syncing) return;
    if (!this.token)
      throw new Error(
        'Для обновления нужен интернет и вход в Maria. Сохранённые товары доступны локально.',
      );
    const controller = new AbortController();
    const epoch = this.epoch;
    this.syncing = controller;
    this.nextSyncAt = Date.now() + 60_000;
    this.syncTask = this.sync
      .run(scope, controller.signal)
      .then(() => {
        if (epoch === this.epoch && !controller.signal.aborted) {
          this.online = true;
          this.error = null;
        }
      })
      .catch(async (error: unknown) => {
        if (epoch !== this.epoch || controller.signal.aborted) return;
        this.online = false;
        if (error instanceof CatalogApiError && error.status === 403)
          await this.disconnect();
        else if (error instanceof CatalogApiError && error.status === 401) {
          this.requestRefresh();
        }
        if (error instanceof CatalogApiError && error.retryAfterMs)
          this.nextSyncAt = Date.now() + error.retryAfterMs;
        this.error = message(error);
      })
      .finally(() => {
        if (this.syncing === controller) this.syncing = null;
        this.changed();
      });
  }

  private preview(productIds?: string[]): UploadPreview {
    const scope = this.assertAccess();
    const state = this.db.getState(scope);
    const device = this.db.getDevice(scope);
    const profile = this.db.getProgress(scope)?.profile ?? state.profile;
    const blockers: string[] = [];
    if (!state.sync.lastSyncedAt)
      blockers.push('Сначала завершите загрузку каталога из Maria.');
    if (!profile?.enabled || !profile.prefix || profile.prefix === '29')
      blockers.push(
        'Включите профиль весовых штрихкодов в Maria → Настройки → Организация.',
      );
    if (profile?.blocked_reason)
      blockers.push(
        'Префикс организации конфликтует со штрихкодами товаров. Исправьте конфликт в Maria.',
      );
    if (!device?.setupConfirmed)
      blockers.push(
        'Настройте весы и подтвердите соответствие этикетки и кодировки.',
      );
    if (device && profile?.prefix !== device.barcodePrefix)
      blockers.push(
        'Префикс в настройке весов отличается от профиля организации.',
      );
    const all = this.db.allProducts(scope);
    const selected = productIds ? new Set(productIds) : null;
    const products = selected
      ? all.filter((product) => selected.has(product.id))
      : all;
    if (
      selected &&
      (selected.size !== productIds!.length ||
        products.length !== selected.size)
    )
      blockers.push(
        'Выбранные товары изменились. Обновите список и предпросмотр.',
      );
    const seen = new Set<number>();
    for (const product of all) {
      if (product.scale_plu !== null && seen.has(product.scale_plu)) {
        blockers.push('В каталоге повторяются PLU. Исправьте данные в Maria.');
        break;
      }
      if (product.scale_plu !== null) seen.add(product.scale_plu);
    }
    const ready = products.filter(
      (product) => productIssues(product, device).length === 0,
    );
    if (ready.length > 10_000)
      blockers.push(
        'За один запуск можно отправить до 10 000 товаров. Выберите меньшую группу.',
      );
    const excluded = products
      .filter((product) => productIssues(product, device).length > 0)
      .map((product) => ({
        id: product.id,
        name: product.name,
        issues: productIssues(product, device),
      }));
    const byId = new Map(all.map((product) => [product.id, product]));
    const removalRequired = device
      ? this.db
          .uploadedProducts(scope, device)
          .filter((old) => {
            const current = byId.get(old.id);
            return (
              !current ||
              !current.is_active ||
              current.scale_plu !== old.scale_plu ||
              productIssues(current, { ...device, setupConfirmed: true })
                .length > 0
            );
          })
          .map((product) => ({
            id: product.id,
            name: product.name,
            plu: product.scale_plu!,
          }))
      : [];
    if (this.isUploading())
      blockers.push('Другая операция с весами ещё выполняется.');
    const uncertain = device
      ? this.db.uncertainProducts(scope, device)
      : new Set<string>();
    const uncertainCount = ready.filter((product) =>
      uncertain.has(product.id),
    ).length;
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          ready,
          excluded,
          profile,
          device,
          uncertainCount,
          lastSyncedAt: state.sync.lastSyncedAt,
        }),
      )
      .digest('hex');
    return {
      revision,
      uncertainCount,
      ready,
      excluded,
      removalRequired,
      blockers,
      catalogSyncedAt: state.sync.lastSyncedAt,
    };
  }

  private startUpload(
    productIds: string[] | undefined,
    confirmUncertain: boolean,
    revision: string,
  ): void {
    const scope = this.assertAccess();
    const preview = this.preview(productIds);
    if (preview.revision !== revision)
      throw new Error(
        'Данные изменились после предпросмотра. Проверьте новый предпросмотр перед загрузкой.',
      );
    if (preview.blockers.length) throw new Error(preview.blockers.join(' '));
    if (!preview.ready.length)
      throw new Error('Нет готовых товаров для отправки.');
    const device = this.db.getDevice(scope)!;
    const adapters = getNetworkAdapters();
    validateProfile(device, adapters);
    if (checkSubnet(device, adapters).status !== 'passed')
      throw new Error('Весы и выбранный адаптер должны быть в одной подсети.');
    if (!confirmUncertain && preview.uncertainCount)
      throw new Error(
        'Предыдущая запись имеет неизвестный результат. Проверьте весы и подтвердите повтор.',
      );
    const job: UploadJob = {
      id: randomUUID(),
      scope,
      device,
      catalogSyncedAt: preview.catalogSyncedAt!,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      items: preview.ready.map((product) => ({
        product,
        packetHex: encodeCatalogProduct(product, device).toString('hex'),
        state: 'pending',
        error: null,
      })),
      events: [],
      error: null,
      disconnectError: null,
    };
    this.db.saveUpload(job);
    this.clearConfirmation = null;
    this.activeJob = job;
    const controller = new AbortController();
    this.uploading = controller;
    this.uploadTask = (this.options.runUpload ?? runUpload)(
      job,
      controller.signal,
      async (snapshot) => {
        // Revocation/expiry stops subsequent writes; completed outcomes still need durable storage.
        if (
          !grantIsValid(this.grant, this.options.apiUrl) ||
          scopeKey(this.grant.scope) !== scopeKey(scope)
        )
          controller.abort();
        const latestProfile = this.db.getProgress(scope)?.profile;
        if (
          latestProfile &&
          (!latestProfile.enabled ||
            latestProfile.blocked_reason ||
            latestProfile.prefix !== device.barcodePrefix)
        )
          controller.abort();
        this.db.saveUpload(snapshot);
        this.activeJob = snapshot;
        this.changed();
      },
    )
      .then((result) => {
        this.activeJob = result;
      })
      .catch((error: unknown) => {
        const result = structuredClone(this.activeJob ?? job);
        result.status = 'interrupted';
        result.finishedAt = new Date().toISOString();
        result.error = message(error);
        result.items.forEach((item) => {
          if (item.state === 'in_flight') item.state = 'uncertain';
        });
        this.activeJob = result;
        try {
          this.db.saveUpload(result);
        } catch {
          this.error =
            'Не удалось сохранить итог отправки. Проверьте свободное место; возможные записи считаются неопределёнными.';
        }
      })
      .finally(() => {
        this.uploading = null;
        this.changed();
      });
    this.changed();
  }

  private clearTarget(scope: CatalogScope): ScaleDevice {
    if (this.isUploading())
      throw new Error('Другая операция с весами ещё выполняется.');
    const device = this.db.getDevice(scope);
    if (!device) throw new Error('Сначала сохраните подключение к весам.');
    const adapters = getNetworkAdapters();
    validateProfile(device, adapters);
    if (checkSubnet(device, adapters).status !== 'passed')
      throw new Error('Весы и выбранный адаптер должны быть в одной подсети.');
    return device;
  }

  private prepareClear(): ClearPluConfirmation {
    const scope = this.assertAccess();
    const confirmation: ClearPluConfirmation = {
      token: randomUUID(),
      device: this.clearTarget(scope),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    this.clearConfirmation = {
      ...structuredClone(confirmation),
      scope: scopeKey(scope),
    };
    return confirmation;
  }

  private startClear(token: string): void {
    const scope = this.assertAccess();
    const confirmation = this.clearConfirmation;
    this.clearConfirmation = null;
    const device = this.clearTarget(scope);
    if (
      !confirmation ||
      token !== confirmation.token ||
      confirmation.scope !== scopeKey(scope) ||
      Date.now() >= new Date(confirmation.expiresAt).getTime() ||
      JSON.stringify(device) !== JSON.stringify(confirmation.device)
    )
      throw new Error(
        'Подтверждение очистки устарело. Проверьте выбранные весы и подтвердите заново.',
      );

    const job: ClearPluJob = {
      id: randomUUID(),
      scope,
      device,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      commandState: 'pending',
      events: [],
      error: null,
      disconnectError: null,
    };
    this.db.saveClear(job);
    this.activeClear = job;
    const controller = new AbortController();
    this.clearing = controller;
    this.clearTask = (this.options.runClearPlu ?? runClearPlu)(
      job,
      controller.signal,
      async (snapshot) => {
        if (
          !grantIsValid(this.grant, this.options.apiUrl) ||
          scopeKey(this.grant.scope) !== scopeKey(scope)
        )
          controller.abort();
        this.db.saveClear(snapshot);
        this.activeClear = structuredClone(snapshot);
        this.changed();
      },
    )
      .then((result) => {
        this.activeClear = result;
      })
      .catch((error: unknown) => {
        const result = structuredClone(this.activeClear ?? job);
        result.status = 'interrupted';
        result.finishedAt = new Date().toISOString();
        result.error = message(error);
        if (result.commandState === 'in_flight')
          result.commandState = 'uncertain';
        this.activeClear = result;
        try {
          this.db.saveClear(result);
        } catch {
          this.error =
            'Не удалось сохранить итог очистки. Результат неизвестен: проверьте товары на весах.';
        }
      })
      .finally(() => {
        this.clearing = null;
        this.changed();
      });
    this.changed();
  }

  async request(input: CatalogRequest): Promise<unknown> {
    if (this.closed) throw new Error('Приложение завершает работу.');
    switch (input.type) {
      case 'state':
        return this.state();
      case 'connect': {
        const pending = this.connect(input.accessToken);
        this.connections.add(pending);
        try {
          await pending;
        } finally {
          this.connections.delete(pending);
        }
        return this.state();
      }
      case 'disconnect':
        await this.disconnect();
        return this.state();
      case 'adapters':
        return getNetworkAdapters();
      case 'list': {
        const scope = this.assertAccess();
        const page = this.db.listProducts(scope, input.search, input.offset);
        const device = this.db.getDevice(scope);
        return {
          ...page,
          products: page.products.map((product) => ({
            ...product,
            issues: productIssues(product, device),
          })),
        };
      }
      case 'sync':
        this.syncPaused = false;
        this.assertAccess();
        if (!this.token) {
          // A manual retry may recover a refresh that failed while offline.
          this.refreshRequested = false;
          this.requestRefresh();
          return this.state();
        }
        this.startSync();
        return this.state();
      case 'cancel-sync':
        this.syncPaused = true;
        this.syncing?.abort();
        await this.syncTask;
        return this.state();
      case 'save-device': {
        const scope = this.assertAccess();
        if (this.isUploading())
          throw new Error(
            'Остановите отправку перед изменением настроек весов.',
          );
        validateProfile(input.device, getNetworkAdapters());
        const prefix = (
          this.db.getProgress(scope)?.profile ?? this.db.getState(scope).profile
        )?.prefix;
        if (input.device.barcodePrefix !== prefix)
          throw new Error(
            'Используйте сохранённый в Maria префикс организации.',
          );
        this.db.saveDevice(scope, input.device);
        this.clearConfirmation = null;
        this.changed();
        return this.state();
      }
      case 'preview':
        return this.preview(input.productIds);
      case 'upload':
        this.startUpload(
          input.productIds,
          input.confirmUncertain,
          input.revision,
        );
        return this.state();
      case 'cancel-upload':
        this.uploading?.abort();
        await this.uploadTask;
        return this.state();
      case 'prepare-clear':
        return this.prepareClear();
      case 'clear-products':
        this.startClear(input.token);
        return this.state();
      case 'cancel-clear':
        this.clearing?.abort();
        await this.clearTask;
        return this.state();
      case 'export-clear':
        this.assertAccess();
        return this.state().latestClear;
      case 'export-upload':
        this.assertAccess();
        return this.state().latestUpload;
    }
  }

  async tick(): Promise<void> {
    if (!this.grant || this.closed) return;
    try {
      this.assertAccess();
      this.grant!.lastSeenAt = Math.max(this.grant!.lastSeenAt, Date.now());
      await this.options.persistGrant(this.grant);
      if (this.closed) return;
      if (this.token && !this.syncPaused && Date.now() >= this.nextSyncAt)
        this.startSync();
    } catch (error) {
      this.error = message(error);
      this.changed();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.epoch++;
    this.connecting?.abort();
    this.syncing?.abort();
    this.uploading?.abort();
    this.clearing?.abort();
    this.clearConfirmation = null;
    await Promise.allSettled([
      ...this.connections,
      this.syncTask,
      this.uploadTask,
      this.clearTask,
    ]);
  }
}
