import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import type {
  CatalogProduct,
  CatalogScope,
  CatalogSyncState,
  ClearPluJob,
  ScaleBarcodeProfile,
  ScaleDevice,
  UploadJob,
} from '../../shared/catalog';
import { mergeScaleProfiles, scaleProfileSchema } from './profile';

export const scopeKey = (scope: CatalogScope): string =>
  JSON.stringify([
    scope.apiUrl,
    scope.userId,
    scope.membershipId,
    scope.organizationId,
    scope.storeId,
  ]);
const organizationKey = (
  scope: Pick<CatalogScope, 'apiUrl' | 'organizationId'>,
): string =>
  JSON.stringify([
    new URL(scope.apiUrl).href.replace(/\/$/, ''),
    scope.organizationId,
  ]);
const storedScopeOrganizationKey = (key: string): string => {
  const [apiUrl, , , organizationId] = JSON.parse(key) as string[];
  return organizationKey({ apiUrl, organizationId });
};
const legacyProfileSchema = scaleProfileSchema.extend({
  blocked_reason: z.enum(['barcode_conflict']).nullable(),
  revision: scaleProfileSchema.shape.revision.default(0),
  issued_plu_ranges: scaleProfileSchema.shape.issued_plu_ranges.default([]),
});
const deviceKey = (device: ScaleDevice): string =>
  JSON.stringify([device.scaleIp, device.port]);
const deviceScopeKey = (scope: CatalogScope): string =>
  JSON.stringify([
    new URL(scope.apiUrl).href.replace(/\/$/, ''),
    scope.organizationId,
    scope.storeId,
  ]);
type UploadHeader = Omit<UploadJob, 'items' | 'events'>;
type UploadCheckpoint = {
  id: string;
  scope: string;
  device: string;
  header: string;
  items: string[];
  events: string[];
};

export type CatalogProgress = {
  cursor: string;
  after: string | null;
  phase: 'pages' | 'changes';
  loaded: number;
  staging: boolean;
  profile: ScaleBarcodeProfile;
  hasMore: boolean;
  waiting: boolean;
};
export type CatalogChanges = {
  products: CatalogProduct[];
  deleted_ids: string[];
  cursor: string;
  has_more: boolean;
  waiting_for_transactions?: boolean;
  scale_profile: ScaleBarcodeProfile;
};
type StoredState = {
  active: string;
  staging: string | null;
  cursor: string | null;
  profile: ScaleBarcodeProfile | null;
  progress: CatalogProgress | null;
  sync: CatalogSyncState;
};
const emptyState = (): StoredState => ({
  active: randomUUID(),
  staging: null,
  cursor: null,
  profile: null,
  progress: null,
  sync: { phase: 'idle', loaded: 0, lastSyncedAt: null, error: null },
});

/** Owned by the catalog worker. Transactions keep data and resume markers inseparable. */
export class CatalogDatabase {
  private readonly db: DatabaseSync;
  private uploadCheckpoint: UploadCheckpoint | null = null;
  private readonly immutableUploadJson = new WeakMap<object, string>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;',
    );
    if (
      Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 1
    ) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE catalog_state(scope TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE catalog_products(scope TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,generation,id));
          CREATE INDEX catalog_products_name ON catalog_products(scope,generation,name,id);
          CREATE TABLE catalog_devices(scope TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE catalog_uploads(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, device TEXT NOT NULL, value TEXT NOT NULL);
          CREATE INDEX catalog_uploads_scope ON catalog_uploads(scope,sequence);
          PRAGMA user_version=1;
        `);
      });
    }
    if (
      Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 2
    ) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE catalog_uploads ADD COLUMN device_scope TEXT NOT NULL DEFAULT '';
          CREATE INDEX catalog_uploads_device_scope ON catalog_uploads(device_scope,device,sequence);
          CREATE TABLE upload_items(job_id TEXT NOT NULL REFERENCES catalog_uploads(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(job_id,ordinal));
          CREATE TABLE upload_events(job_id TEXT NOT NULL REFERENCES catalog_uploads(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(job_id,ordinal));
        `);
        for (const row of this.db
          .prepare('SELECT value FROM catalog_uploads')
          .all()) {
          const { items, events, ...header } = JSON.parse(
            String(row.value),
          ) as UploadJob;
          this.writeUploadRows(
            'upload_items',
            header.id,
            items.map((item) => JSON.stringify(item)),
            [],
          );
          this.writeUploadRows(
            'upload_events',
            header.id,
            events.map((event) => JSON.stringify(event)),
            [],
          );
          this.db
            .prepare(
              'UPDATE catalog_uploads SET value=?,device_scope=? WHERE id=?',
            )
            .run(
              JSON.stringify(header),
              deviceScopeKey(header.scope),
              header.id,
            );
        }
        this.db.exec('PRAGMA user_version=2;');
      });
    }
    if (
      Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 3
    ) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE catalog_clears(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, device TEXT NOT NULL, value TEXT NOT NULL, history_reset_sequence INTEGER);
          CREATE INDEX catalog_clears_scope ON catalog_clears(scope,sequence);
          CREATE INDEX catalog_clears_device ON catalog_clears(device,history_reset_sequence);
          PRAGMA user_version=3;
        `);
      });
    }
    if (
      Number(this.db.prepare('PRAGMA user_version').get()?.user_version) < 4
    ) {
      this.transaction(() => {
        this.db.exec(
          'CREATE TABLE catalog_profiles(organization TEXT PRIMARY KEY,value TEXT NOT NULL,authoritative INTEGER NOT NULL DEFAULT 1);',
        );
        if (
          this.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_state'",
            )
            .get()
        ) {
          for (const row of this.db
            .prepare('SELECT scope,value FROM catalog_state')
            .all()) {
            const state = JSON.parse(String(row.value)) as StoredState;
            const [apiUrl, userId, membershipId, organizationId, storeId] =
              JSON.parse(String(row.scope)) as string[];
            const scope = {
              apiUrl,
              userId,
              membershipId,
              organizationId,
              storeId,
              storeName: '',
            };
            for (const candidate of [state.profile, state.progress?.profile]) {
              if (candidate)
                this.writeProfile(
                  scope,
                  legacyProfileSchema.parse(candidate),
                  candidate.revision !== undefined,
                );
            }
          }
        }
        this.db.exec('PRAGMA user_version=4;');
      });
    }
    this.transaction(() => {
      // Outcomes are checkpointed before disconnect finishes. A terminal status
      // without finishedAt still represents an operation interrupted by exit.
      for (const row of this.db
        .prepare(
          "SELECT id,value FROM catalog_uploads WHERE json_extract(value,'$.status')='running' OR json_extract(value,'$.finishedAt') IS NULL",
        )
        .all()) {
        const header = JSON.parse(String(row.value)) as UploadHeader;
        header.status = 'interrupted';
        header.finishedAt = new Date().toISOString();
        header.error =
          'Приложение закрылось во время отправки. Проверьте результат на весах.';
        this.db
          .prepare('UPDATE catalog_uploads SET value=? WHERE id=?')
          .run(JSON.stringify(header), header.id);
        for (const itemRow of this.db
          .prepare(
            "SELECT ordinal,value FROM upload_items WHERE job_id=? AND json_extract(value,'$.state')='in_flight'",
          )
          .all(header.id)) {
          const item = JSON.parse(
            String(itemRow.value),
          ) as UploadJob['items'][number];
          item.state = 'uncertain';
          this.db
            .prepare(
              'UPDATE upload_items SET value=? WHERE job_id=? AND ordinal=?',
            )
            .run(JSON.stringify(item), header.id, Number(itemRow.ordinal));
        }
      }
      for (const row of this.db
        .prepare(
          "SELECT value FROM catalog_clears WHERE json_extract(value,'$.status')='running' OR json_extract(value,'$.finishedAt') IS NULL",
        )
        .all()) {
        const job = JSON.parse(String(row.value)) as ClearPluJob;
        job.status = 'interrupted';
        job.finishedAt = new Date().toISOString();
        job.error =
          'Приложение закрылось во время очистки. Проверьте результат на весах.';
        if (job.commandState === 'in_flight') job.commandState = 'uncertain';
        this.db
          .prepare('UPDATE catalog_clears SET value=? WHERE id=?')
          .run(JSON.stringify(job), job.id);
      }
    });
  }
  close(): void {
    this.db.close();
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private state(scope: CatalogScope): StoredState {
    const row = this.db
      .prepare('SELECT value FROM catalog_state WHERE scope=?')
      .get(scopeKey(scope));
    return row ? (JSON.parse(String(row.value)) as StoredState) : emptyState();
  }
  private writeState(scope: CatalogScope, state: StoredState): void {
    this.db
      .prepare(
        'INSERT INTO catalog_state(scope,value) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value',
      )
      .run(scopeKey(scope), JSON.stringify(state));
  }
  getProfile(scope: CatalogScope): ScaleBarcodeProfile | null {
    const row = this.db
      .prepare('SELECT value FROM catalog_profiles WHERE organization=?')
      .get(organizationKey(scope));
    return row ? (JSON.parse(String(row.value)) as ScaleBarcodeProfile) : null;
  }
  saveProfile(
    scope: CatalogScope,
    profile: ScaleBarcodeProfile,
  ): ScaleBarcodeProfile {
    return this.transaction(() => this.writeProfile(scope, profile));
  }
  private writeProfile(
    scope: CatalogScope,
    incoming: ScaleBarcodeProfile,
    authoritative = true,
  ): ScaleBarcodeProfile {
    const current = this.getProfile(scope);
    const organization = organizationKey(scope);
    const known =
      this.db
        .prepare(
          'SELECT authoritative FROM catalog_profiles WHERE organization=?',
        )
        .get(organization)?.authoritative === 1;
    const merged = mergeScaleProfiles(current, incoming);
    // Legacy cached settings predate revisions and cannot outrank the first server profile.
    const profile =
      current && !known && authoritative
        ? { ...incoming, issued_plu_ranges: merged.issued_plu_ranges }
        : merged;
    this.db
      .prepare(
        'INSERT INTO catalog_profiles(organization,value,authoritative) VALUES (?,?,?) ON CONFLICT(organization) DO UPDATE SET value=excluded.value,authoritative=excluded.authoritative',
      )
      .run(
        organization,
        JSON.stringify(profile),
        Number(known || authoritative),
      );
    if (
      current &&
      (profile.revision !== current.revision ||
        profile.prefix !== current.prefix ||
        profile.enabled !== current.enabled)
    ) {
      for (const row of this.db
        .prepare('SELECT scope,value FROM catalog_devices')
        .all()) {
        if (storedScopeOrganizationKey(String(row.scope)) !== organization)
          continue;
        const device = JSON.parse(String(row.value)) as ScaleDevice;
        device.setupConfirmed = false;
        device.reloadRequired = true;
        this.db
          .prepare('UPDATE catalog_devices SET value=? WHERE scope=?')
          .run(JSON.stringify(device), String(row.scope));
      }
    }
    return profile;
  }
  beginSnapshot(
    scope: CatalogScope,
    cursor: string,
    profile: ScaleBarcodeProfile,
  ): void {
    this.transaction(() => {
      profile = this.writeProfile(scope, profile);
      const state = this.state(scope);
      if (state.staging)
        this.db
          .prepare(
            'DELETE FROM catalog_products WHERE scope=? AND generation=?',
          )
          .run(scopeKey(scope), state.staging);
      state.staging = randomUUID();
      state.progress = {
        cursor,
        after: null,
        phase: 'pages',
        loaded: 0,
        staging: true,
        profile,
        hasMore: true,
        waiting: false,
      };
      state.sync = { ...state.sync, phase: 'pages', loaded: 0, error: null };
      this.writeState(scope, state);
    });
  }
  getProgress(scope: CatalogScope): CatalogProgress | null {
    const state = this.state(scope);
    const profile = this.getProfile(scope);
    return (
      (state.progress && profile ? { ...state.progress, profile } : null) ??
      (state.cursor && profile
        ? {
            cursor: state.cursor,
            after: null,
            phase: 'changes',
            loaded: 0,
            staging: false,
            profile,
            hasMore: false,
            waiting: false,
          }
        : null)
    );
  }
  private writeProducts(
    scope: CatalogScope,
    generation: string,
    products: CatalogProduct[],
  ): void {
    const statement = this.db.prepare(
      'INSERT INTO catalog_products(scope,generation,id,name,value) VALUES (?,?,?,?,?) ON CONFLICT(scope,generation,id) DO UPDATE SET name=excluded.name,value=excluded.value',
    );
    for (const product of products)
      statement.run(
        scopeKey(scope),
        generation,
        product.id,
        product.name.toLocaleLowerCase('ru'),
        JSON.stringify(product),
      );
  }
  applyPage(
    scope: CatalogScope,
    products: CatalogProduct[],
    next: string | null,
    profile?: ScaleBarcodeProfile,
  ): void {
    this.transaction(() => {
      const state = this.state(scope);
      if (!state.staging || !state.progress || state.progress.phase !== 'pages')
        throw new Error('Нет незавершённой загрузки каталога.');
      if (profile) state.progress.profile = this.writeProfile(scope, profile);
      this.writeProducts(scope, state.staging, products);
      state.progress = {
        ...state.progress,
        after: next,
        phase: next === null ? 'changes' : 'pages',
        loaded: state.progress.loaded + products.length,
      };
      state.sync = {
        ...state.sync,
        phase: state.progress.phase,
        loaded: state.progress.loaded,
        error: null,
      };
      this.writeState(scope, state);
    });
  }
  applyChanges(scope: CatalogScope, changes: CatalogChanges): void {
    this.transaction(() => {
      const state = this.state(scope);
      const progress = this.getProgress(scope);
      if (!progress || progress.phase !== 'changes')
        throw new Error('Каталог ещё не готов принимать изменения.');
      if (
        !state.staging &&
        (changes.products.length || changes.deleted_ids.length)
      ) {
        state.staging = randomUUID();
        this.db
          .prepare(
            'INSERT INTO catalog_products(scope,generation,id,name,value) SELECT scope,?,id,name,value FROM catalog_products WHERE scope=? AND generation=?',
          )
          .run(state.staging, scopeKey(scope), state.active);
      }
      const generation = state.staging ?? state.active;
      this.writeProducts(scope, generation, changes.products);
      const remove = this.db.prepare(
        'DELETE FROM catalog_products WHERE scope=? AND generation=? AND id=?',
      );
      for (const id of changes.deleted_ids)
        remove.run(scopeKey(scope), generation, id);
      state.progress = {
        ...progress,
        staging: state.staging !== null,
        cursor: changes.cursor,
        profile: this.writeProfile(scope, changes.scale_profile),
        loaded:
          progress.loaded +
          changes.products.length +
          changes.deleted_ids.length,
        hasMore: changes.has_more,
        waiting: changes.waiting_for_transactions === true,
      };
      state.sync = {
        ...state.sync,
        phase: 'changes',
        loaded: state.progress.loaded,
        error: null,
      };
      this.writeState(scope, state);
    });
  }
  finishSync(scope: CatalogScope, at: string): void {
    this.transaction(() => {
      const state = this.state(scope);
      const progress = state.progress;
      if (
        !progress ||
        progress.phase !== 'changes' ||
        progress.hasMore ||
        progress.waiting
      )
        throw new Error('Синхронизация каталога ещё не завершена.');
      state.active = state.staging ?? state.active;
      state.staging = null;
      state.cursor = progress.cursor;
      state.profile = this.getProfile(scope);
      state.progress = null;
      state.sync = {
        phase: 'idle',
        loaded: progress.loaded,
        lastSyncedAt: at,
        profileRevision: state.profile?.revision ?? 0,
        error: null,
      };
      this.writeState(scope, state);
      this.db
        .prepare('DELETE FROM catalog_products WHERE scope=? AND generation<>?')
        .run(scopeKey(scope), state.active);
    });
  }
  setSyncState(
    scope: CatalogScope,
    update: Pick<CatalogSyncState, 'phase' | 'error'>,
  ): void {
    const state = this.state(scope);
    state.sync = { ...state.sync, ...update };
    this.writeState(scope, state);
  }
  getState(scope: CatalogScope): {
    sync: CatalogSyncState;
    profile: ScaleBarcodeProfile | null;
    total: number;
  } {
    const state = this.state(scope);
    const total = Number(
      this.db
        .prepare(
          'SELECT COUNT(*) AS total FROM catalog_products WHERE scope=? AND generation=?',
        )
        .get(scopeKey(scope), state.active)?.total ?? 0,
    );
    return { sync: state.sync, profile: this.getProfile(scope), total };
  }
  listProducts(
    scope: CatalogScope,
    search = '',
    offset = 0,
    limit = 100,
  ): { products: CatalogProduct[]; total: number } {
    const state = this.state(scope);
    const filter = search.trim().toLocaleLowerCase('ru');
    const args = [scopeKey(scope), state.active, filter];
    const where = 'scope=? AND generation=? AND instr(name,?)>0';
    const total = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS total FROM catalog_products WHERE ${where}`,
        )
        .get(...args)?.total ?? 0,
    );
    const rows = this.db
      .prepare(
        `SELECT value FROM catalog_products WHERE ${where} ORDER BY name,id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
    return {
      products: rows.map(
        (row) => JSON.parse(String(row.value)) as CatalogProduct,
      ),
      total,
    };
  }
  allProducts(scope: CatalogScope): CatalogProduct[] {
    return this.db
      .prepare(
        'SELECT value FROM catalog_products WHERE scope=? AND generation=? ORDER BY id',
      )
      .all(scopeKey(scope), this.state(scope).active)
      .map((row) => JSON.parse(String(row.value)) as CatalogProduct);
  }
  getCatalogGeneration(scope: CatalogScope): string {
    return this.state(scope).active;
  }
  saveDevice(scope: CatalogScope, device: ScaleDevice): void {
    this.db
      .prepare(
        'INSERT INTO catalog_devices(scope,value) VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value',
      )
      .run(scopeKey(scope), JSON.stringify(device));
  }
  getDevice(scope: CatalogScope): ScaleDevice | null {
    const row = this.db
      .prepare('SELECT value FROM catalog_devices WHERE scope=?')
      .get(scopeKey(scope));
    return row ? (JSON.parse(String(row.value)) as ScaleDevice) : null;
  }
  saveClear(job: ClearPluJob): void {
    const scope = scopeKey(job.scope);
    const device = deviceKey(job.device);
    this.transaction(() => {
      const previous = this.db
        .prepare(
          'SELECT scope,device,history_reset_sequence FROM catalog_clears WHERE id=?',
        )
        .get(job.id);
      if (previous && (previous.scope !== scope || previous.device !== device))
        throw new Error(
          'Очистка уже принадлежит другому магазину или устройству.',
        );
      let historyResetSequence = previous?.history_reset_sequence ?? null;
      // Only the first durable ACK invalidates previous contents. Disconnect
      // checkpoints must not invalidate uploads created after that ACK.
      if (
        historyResetSequence === null &&
        job.commandState === 'acknowledged'
      ) {
        historyResetSequence = this.db
          .prepare(
            'SELECT COALESCE(MAX(sequence),0) AS sequence FROM catalog_uploads',
          )
          .get()!.sequence;
        for (const row of this.db
          .prepare('SELECT scope,value FROM catalog_devices')
          .all()) {
          const savedDevice = JSON.parse(String(row.value)) as ScaleDevice;
          if (deviceKey(savedDevice) !== device) continue;
          this.db
            .prepare('UPDATE catalog_devices SET value=? WHERE scope=?')
            .run(
              JSON.stringify({ ...savedDevice, reloadRequired: true }),
              String(row.scope),
            );
        }
      }
      this.db
        .prepare(
          'INSERT INTO catalog_clears(id,scope,device,value,history_reset_sequence) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,history_reset_sequence=excluded.history_reset_sequence',
        )
        .run(job.id, scope, device, JSON.stringify(job), historyResetSequence);
    });
  }
  getLatestClear(scope: CatalogScope): ClearPluJob | null {
    const row = this.db
      .prepare(
        'SELECT value FROM catalog_clears WHERE scope=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(scopeKey(scope));
    return row ? (JSON.parse(String(row.value)) as ClearPluJob) : null;
  }
  saveUpload(job: UploadJob): void {
    const { items, events, ...header } = job;
    const next: UploadCheckpoint = {
      id: job.id,
      scope: scopeKey(job.scope),
      device: deviceKey(job.device),
      header: JSON.stringify(header),
      items: items.map((item) => this.serializeUploadEntry(item)),
      events: events.map((event) => this.serializeUploadEntry(event)),
    };
    let previous =
      this.uploadCheckpoint?.id === job.id ? this.uploadCheckpoint : null;
    if (!previous) {
      const row = this.db
        .prepare('SELECT scope,device,value FROM catalog_uploads WHERE id=?')
        .get(job.id);
      if (row)
        previous = {
          id: job.id,
          scope: String(row.scope),
          device: String(row.device),
          header: String(row.value),
          items: this.uploadRows('upload_items', job.id),
          events: this.uploadRows('upload_events', job.id),
        };
    }
    if (
      previous &&
      (previous.scope !== next.scope || previous.device !== next.device)
    )
      throw new Error(
        'Отправка уже принадлежит другому магазину или устройству.',
      );
    this.transaction(() => {
      if (!previous)
        this.db
          .prepare(
            'INSERT INTO catalog_uploads(id,scope,device,device_scope,value) VALUES (?,?,?,?,?)',
          )
          .run(
            job.id,
            next.scope,
            next.device,
            deviceScopeKey(job.scope),
            next.header,
          );
      else if (previous.header !== next.header)
        this.db
          .prepare('UPDATE catalog_uploads SET value=? WHERE id=?')
          .run(next.header, job.id);
      this.writeUploadRows(
        'upload_items',
        job.id,
        next.items,
        previous?.items ?? [],
      );
      this.writeUploadRows(
        'upload_events',
        job.id,
        next.events,
        previous?.events ?? [],
      );
    });
    // Only advance the comparison cache after the complete checkpoint is durable.
    this.uploadCheckpoint = next;
  }
  private serializeUploadEntry(
    entry: UploadJob['items'][number] | UploadJob['events'][number],
  ): string {
    // Uploader records are immutable; other callers may still mutate objects in place.
    const immutable =
      Object.isFrozen(entry) &&
      (!('product' in entry) || Object.isFrozen(entry.product));
    if (!immutable) return JSON.stringify(entry);
    const existing = this.immutableUploadJson.get(entry);
    if (existing !== undefined) return existing;
    const value = JSON.stringify(entry);
    this.immutableUploadJson.set(entry, value);
    return value;
  }
  private uploadRows(
    table: 'upload_items' | 'upload_events',
    id: string,
  ): string[] {
    return this.db
      .prepare(`SELECT value FROM ${table} WHERE job_id=? ORDER BY ordinal`)
      .all(id)
      .map((row) => String(row.value));
  }
  private writeUploadRows(
    table: 'upload_items' | 'upload_events',
    id: string,
    values: string[],
    previous: string[],
  ): void {
    const statement = this.db.prepare(
      `INSERT INTO ${table}(job_id,ordinal,value) VALUES (?,?,?) ON CONFLICT(job_id,ordinal) DO UPDATE SET value=excluded.value`,
    );
    values.forEach((value, ordinal) => {
      if (value !== previous[ordinal]) statement.run(id, ordinal, value);
    });
    if (previous.length > values.length)
      this.db
        .prepare(`DELETE FROM ${table} WHERE job_id=? AND ordinal>=?`)
        .run(id, values.length);
  }
  getLatestUpload(scope: CatalogScope): UploadJob | null {
    const row = this.db
      .prepare(
        'SELECT id,value FROM catalog_uploads WHERE scope=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(scopeKey(scope));
    return row
      ? {
          ...(JSON.parse(String(row.value)) as UploadHeader),
          items: this.uploadRows('upload_items', String(row.id)).map(
            (value) => JSON.parse(value) as UploadJob['items'][number],
          ),
          events: this.uploadRows('upload_events', String(row.id)).map(
            (value) => JSON.parse(value) as UploadJob['events'][number],
          ),
        }
      : null;
  }
  private deviceHistory(
    scope: CatalogScope,
    device: ScaleDevice,
  ): Array<{
    item: UploadJob['items'][number];
    profileRevision: unknown;
    barcodePrefix: unknown;
  }> {
    return this.db
      .prepare(
        `SELECT i.value,json_extract(j.value,'$.profileRevision') AS profile_revision,json_extract(j.value,'$.device.barcodePrefix') AS barcode_prefix FROM catalog_uploads j JOIN upload_items i ON i.job_id=j.id WHERE j.device_scope=? AND j.device=? AND j.sequence>COALESCE((SELECT MAX(history_reset_sequence) FROM catalog_clears WHERE device=j.device),0) AND json_extract(i.value,'$.state') IN ('acknowledged','uncertain','in_flight') ORDER BY j.sequence,i.ordinal`,
      )
      .all(deviceScopeKey(scope), deviceKey(device))
      .map((row) => ({
        item: JSON.parse(String(row.value)) as UploadJob['items'][number],
        profileRevision: row.profile_revision,
        barcodePrefix: row.barcode_prefix,
      }));
  }
  uploadedProducts(scope: CatalogScope, device: ScaleDevice): CatalogProduct[] {
    const products = new Map<string, CatalogProduct>();
    for (const { item } of this.deviceHistory(scope, device))
      products.set(item.product.id, item.product);
    return [...products.values()];
  }
  uploadedPackets(
    scope: CatalogScope,
    device: ScaleDevice,
    profileRevision: number,
  ): Map<string, string> {
    const packets = new Map<string, string>();
    for (const entry of this.deviceHistory(scope, device)) {
      packets.delete(entry.item.product.id);
      if (
        entry.item.state === 'acknowledged' &&
        entry.profileRevision === profileRevision &&
        entry.barcodePrefix === device.barcodePrefix
      )
        packets.set(entry.item.product.id, entry.item.packetHex);
    }
    return packets;
  }
  uncertainProducts(scope: CatalogScope, device: ScaleDevice): Set<string> {
    const uncertain = new Set<string>();
    for (const { item } of this.deviceHistory(scope, device)) {
      if (item.state === 'acknowledged') uncertain.delete(item.product.id);
      else uncertain.add(item.product.id);
    }
    return uncertain;
  }
}
