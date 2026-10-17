import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

import type { CatalogProduct, CatalogScope } from '../../shared/catalog';
import { CatalogApiError } from './api';
import { CatalogDatabase, scopeKey } from './database';
import { scaleProfileSchema } from './profile';

const productSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  store_id: z.string().uuid(),
  name: z.string().max(1000),
  scale_name: z.string().max(255).nullable(),
  scale_plu: z.number().int().min(1).max(99999).nullable(),
  barcode: z.string().max(512),
  unit: z.literal('kg'),
  retail_price: z
    .string()
    .regex(/^\d{1,16}(?:\.\d{1,2})?$/)
    .nullable(),
  is_active: z.boolean(),
  updated_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});
const cursorSchema = z.string().min(1).max(8192);
const startSchema = z.object({
  cursor: cursorSchema,
  scale_profile: scaleProfileSchema,
});
const pageSchema = z.object({
  products: z.array(productSchema).max(250),
  next_cursor: z.string().uuid().nullable(),
  scale_profile: scaleProfileSchema.optional(),
});
const changesSchema = z.object({
  products: z.array(productSchema).max(250),
  deleted_ids: z.array(z.string().uuid()).max(250),
  cursor: cursorSchema,
  has_more: z.boolean(),
  categories_changed: z.boolean(),
  waiting_for_transactions: z.boolean().optional(),
  scale_profile: scaleProfileSchema,
});
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error('Сервер вернул некорректный пакет каталога.');
  return result.data;
};
const validateScope = (
  scope: CatalogScope,
  products: CatalogProduct[],
): void => {
  if (
    products.some(
      (product) =>
        product.organization_id !== scope.organizationId ||
        product.store_id !== scope.storeId,
    ) ||
    new Set(products.map((product) => product.id)).size !== products.length
  )
    throw new Error(
      'Сервер вернул товары другого магазина или повторяющиеся товары.',
    );
};
export type CatalogRequestApi = (
  path: string,
  signal: AbortSignal,
) => Promise<unknown>;

export class CatalogSync {
  private readonly cooldowns = new Map<string, number>();
  private readonly changed: () => void;
  private readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(
    private readonly db: CatalogDatabase,
    private readonly request: CatalogRequestApi,
    options: {
      changed?: () => void;
      delay?: (ms: number, signal: AbortSignal) => Promise<void>;
    } = {},
  ) {
    this.changed = options.changed ?? (() => undefined);
    this.pause =
      options.delay ??
      (async (ms, signal) => {
        await delay(ms, undefined, { signal });
      });
  }
  async run(scope: CatalogScope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (Date.now() < (this.cooldowns.get(scopeKey(scope)) ?? 0))
      throw new Error(
        'Сервер попросил подождать перед повторной синхронизацией.',
      );
    let rebuild = false;
    let forceSnapshot = false;
    try {
      while (true) {
        try {
          let progress = this.db.getProgress(scope);
          if (!progress || forceSnapshot) {
            const start = parse(
              startSchema,
              await this.request('/v1/pos/catalog/sync-start?unit=kg', signal),
            );
            signal.throwIfAborted();
            this.db.beginSnapshot(scope, start.cursor, start.scale_profile);
            progress = this.db.getProgress(scope)!;
            forceSnapshot = false;
          }
          this.db.setSyncState(scope, { phase: progress.phase, error: null });
          this.changed();
          while (progress.phase === 'pages') {
            const params = new URLSearchParams({ unit: 'kg', limit: '250' });
            if (progress.after) params.set('after', progress.after);
            const page = parse(
              pageSchema,
              await this.request(`/v1/pos/catalog/page?${params}`, signal),
            );
            signal.throwIfAborted();
            validateScope(scope, page.products);
            if (
              page.products.some(
                (product, index) =>
                  product.id <=
                  (index
                    ? page.products[index - 1].id
                    : (progress!.after ?? '')),
              ) ||
              (page.next_cursor !== null &&
                page.next_cursor !== page.products.at(-1)?.id)
            )
              throw new Error('Нарушен порядок страниц каталога.');
            this.db.applyPage(
              scope,
              page.products,
              page.next_cursor,
              page.scale_profile,
            );
            this.changed();
            progress = this.db.getProgress(scope)!;
            await this.pause(250, signal);
            signal.throwIfAborted();
          }
          while (true) {
            const params = new URLSearchParams({
              unit: 'kg',
              limit: '250',
              cursor: progress.cursor,
            });
            const changes = parse(
              changesSchema,
              await this.request(`/v1/pos/catalog/changes?${params}`, signal),
            );
            signal.throwIfAborted();
            validateScope(scope, changes.products);
            if (
              (changes.has_more && changes.cursor === progress.cursor) ||
              changes.products.some((product) =>
                changes.deleted_ids.includes(product.id),
              ) ||
              new Set(changes.deleted_ids).size !== changes.deleted_ids.length
            )
              throw new Error('Некорректный курсор или удаления каталога.');
            this.db.applyChanges(scope, changes);
            this.changed();
            if (!changes.has_more && !changes.waiting_for_transactions) {
              this.db.finishSync(scope, new Date().toISOString());
              this.changed();
              return;
            }
            progress = this.db.getProgress(scope)!;
            await this.pause(
              changes.waiting_for_transactions ? 1000 : 250,
              signal,
            );
            signal.throwIfAborted();
          }
        } catch (error) {
          signal.throwIfAborted();
          if (
            !rebuild &&
            error instanceof CatalogApiError &&
            error.status === 410 &&
            error.code === 'POS_CATALOG_CURSOR_EXPIRED'
          ) {
            rebuild = true;
            forceSnapshot = true;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof CatalogApiError && error.retryAfterMs > 0)
        this.cooldowns.set(scopeKey(scope), Date.now() + error.retryAfterMs);
      this.db.setSyncState(scope, {
        phase: signal.aborted ? 'cancelled' : 'error',
        error: signal.aborted
          ? 'Синхронизация остановлена.'
          : error instanceof Error
            ? error.message
            : 'Не удалось обновить каталог.',
      });
      this.changed();
      throw error;
    }
  }
}
