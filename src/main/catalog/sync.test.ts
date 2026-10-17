// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

import type { CatalogProduct, CatalogScope } from '../../shared/catalog';
import { CatalogApiError } from './api';
import { CatalogDatabase } from './database';
import { CatalogSync } from './sync';

const scope: CatalogScope = {
  apiUrl: 'https://api.test',
  userId: 'user',
  membershipId: 'member',
  organizationId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
  storeName: 'Shop',
};
const product: CatalogProduct = {
  id: '33333333-3333-4333-8333-333333333333',
  organization_id: scope.organizationId,
  store_id: scope.storeId,
  name: 'Apple',
  scale_name: null,
  scale_plu: 1,
  barcode: '123',
  unit: 'kg',
  retail_price: '100.00',
  is_active: true,
  updated_at: '2026-10-11T00:00:00Z',
};
const profile = {
  format: 'ean13-weight-v1' as const,
  prefix: '21',
  enabled: true,
  blocked_reason: null,
  revision: 0,
  issued_plu_ranges: [] as [number, number][],
};
const delta = {
  products: [],
  deleted_ids: [],
  cursor: 'delta',
  has_more: false,
  categories_changed: false,
  scale_profile: profile,
};
const databases: CatalogDatabase[] = [];
const setup = (
  request: (path: string, signal: AbortSignal) => Promise<unknown>,
): { db: CatalogDatabase; sync: CatalogSync } => {
  const db = new CatalogDatabase(':memory:');
  databases.push(db);
  return {
    db,
    sync: new CatalogSync(db, request, { delay: async () => undefined }),
  };
};
afterEach(() => databases.splice(0).forEach((db) => db.close()));

it('keeps newer page metadata when a later empty delta has an older revision', async () => {
  const newer = {
    ...profile,
    prefix: '27',
    revision: 2,
    issued_plu_ranges: [[4245, 4245]] as [number, number][],
  };
  const { db, sync } = setup(async (path) => {
    if (path.includes('/sync-start?'))
      return {
        cursor: 'baseline',
        scale_profile: { ...profile, prefix: '05', revision: 1 },
      };
    if (path.includes('/page?'))
      return { products: [product], next_cursor: null, scale_profile: newer };
    expect(db.getState(scope).profile).toEqual(newer);
    return {
      ...delta,
      scale_profile: { ...profile, prefix: '05', revision: 1 },
    };
  });
  await sync.run(scope, new AbortController().signal);
  expect(db.getState(scope).profile).toEqual(newer);
  expect(db.getState(scope).sync.profileRevision).toBe(2);
});

it.each([
  { revision: -1 },
  { revision: 1.5 },
  { issued_plu_ranges: [[5, 1]] },
  { issued_plu_ranges: [[0, 1]] },
  { issued_plu_ranges: [[1, 100000]] },
  { issued_plu_ranges: [[1, 2, 3]] },
])(
  'rejects malformed profile metadata before creating a snapshot: %j',
  async (invalid) => {
    const { db, sync } = setup(async () => ({
      cursor: 'baseline',
      scale_profile: { ...profile, ...invalid },
    }));
    await expect(sync.run(scope, new AbortController().signal)).rejects.toThrow(
      'некорректный пакет',
    );
    expect(db.getProgress(scope)).toBeNull();
  },
);

it('starts the kg journal before page walking and makes products visible only after catchup', async () => {
  const paths: string[] = [];
  const { db, sync } = setup(async (path) => {
    paths.push(path);
    const url = new URL(path, scope.apiUrl);
    expect(url.searchParams.get('unit')).toBe('kg');
    expect(db.allProducts(scope)).toEqual([]);
    if (url.pathname.endsWith('/sync-start'))
      return { cursor: 'baseline', scale_profile: profile };
    if (url.pathname.endsWith('/page'))
      return { products: [product], next_cursor: null };
    expect(url.searchParams.get('cursor')).toBe('baseline');
    return { ...delta, products: [{ ...product, retail_price: '200.00' }] };
  });
  await sync.run(scope, new AbortController().signal);
  expect(paths.map((path) => path.split('?')[0])).toEqual([
    '/v1/pos/catalog/sync-start',
    '/v1/pos/catalog/page',
    '/v1/pos/catalog/changes',
  ]);
  expect(db.allProducts(scope)[0].retail_price).toBe('200.00');
  expect(db.getState(scope).sync).toMatchObject({ phase: 'idle', error: null });
  expect(db.getState(scope).sync.lastSyncedAt).not.toBeNull();
});

it.each([false, true])(
  'drains more than twenty change pages in one run (existing catalog: %s)',
  async (existingCatalog) => {
    let page = 0;
    const { db, sync } = setup(async (path) => {
      if (path.includes('/sync-start?'))
        return { cursor: 'baseline', scale_profile: profile };
      if (path.includes('/page?'))
        return { products: [product], next_cursor: null };
      const cursor = new URL(path, scope.apiUrl).searchParams.get('cursor');
      expect(cursor).toBe(page === 0 ? 'baseline' : `changes-${page}`);
      expect(db.allProducts(scope)).toEqual(existingCatalog ? [product] : []);
      page++;
      return {
        ...delta,
        products: [
          {
            ...product,
            id:
              page === 1
                ? product.id
                : `44444444-4444-4444-8444-${String(page).padStart(12, '0')}`,
            retail_price: '200.00',
          },
        ],
        cursor: `changes-${page}`,
        has_more: page < 22,
      };
    });
    if (existingCatalog) {
      db.beginSnapshot(scope, 'baseline', profile);
      db.applyPage(scope, [product], null);
      db.applyChanges(scope, { ...delta, cursor: 'baseline' });
      db.finishSync(scope, '2026-10-11T00:00:00Z');
    }

    await sync.run(scope, new AbortController().signal);

    expect(db.allProducts(scope)).toHaveLength(22);
    expect(
      db.allProducts(scope).every((item) => item.retail_price === '200.00'),
    ).toBe(true);
    expect(db.getProgress(scope)?.cursor).toBe('changes-22');
    expect(db.getState(scope).sync).toMatchObject({
      phase: 'idle',
      error: null,
    });
    expect(db.getState(scope).sync.lastSyncedAt).not.toBeNull();
  },
);

it('waits for pending server transactions and finishes without a second run', async () => {
  let changes = 0;
  const { db, sync } = setup(async (path) => {
    if (path.includes('/sync-start?'))
      return { cursor: 'baseline', scale_profile: profile };
    if (path.includes('/page?'))
      return { products: [product], next_cursor: null };
    if (changes > 0) {
      expect(new URL(path, scope.apiUrl).searchParams.get('cursor')).toBe(
        'delta',
      );
      expect(db.getState(scope)).toMatchObject({
        total: 0,
        sync: { phase: 'changes', lastSyncedAt: null },
      });
      expect(db.getProgress(scope)).toMatchObject({
        cursor: 'delta',
        waiting: true,
        profile: { prefix: '22' },
      });
    }
    changes++;
    return {
      ...delta,
      waiting_for_transactions: changes < 3,
      scale_profile: { ...profile, prefix: '22', revision: 1 },
    };
  });
  await sync.run(scope, new AbortController().signal);
  expect(db.getState(scope)).toMatchObject({
    total: 1,
    profile: { prefix: '22' },
    sync: { phase: 'idle' },
  });
});

it('rejects products from another store without advancing page progress', async () => {
  const { db, sync } = setup(async (path) =>
    path.includes('/sync-start?')
      ? { cursor: 'baseline', scale_profile: profile }
      : {
          products: [
            { ...product, store_id: '44444444-4444-4444-8444-444444444444' },
          ],
          next_cursor: null,
        },
  );
  await expect(sync.run(scope, new AbortController().signal)).rejects.toThrow();
  expect(db.getProgress(scope)).toMatchObject({
    cursor: 'baseline',
    after: null,
    loaded: 0,
  });
  expect(db.getState(scope).sync.phase).toBe('error');
});

it('does not write a response delivered after cancellation', async () => {
  const controller = new AbortController();
  const { db, sync } = setup(async (path) => {
    if (path.includes('/sync-start?'))
      return { cursor: 'baseline', scale_profile: profile };
    controller.abort();
    return { products: [product], next_cursor: null };
  });
  await expect(sync.run(scope, controller.signal)).rejects.toThrow();
  expect(db.getProgress(scope)?.loaded).toBe(0);
  expect(db.getState(scope).sync.phase).toBe('cancelled');
});

it('rebuilds an expired journal once while retaining the previous active catalog', async () => {
  let expired = false;
  let starts = 0;
  const { db, sync } = setup(async (path) => {
    if (path.includes('/sync-start?')) {
      starts++;
      return { cursor: 'base', scale_profile: profile };
    }
    if (path.includes('/page?'))
      return { products: [product], next_cursor: null };
    if (expired) {
      expired = false;
      throw new CatalogApiError(410, 'POS_CATALOG_CURSOR_EXPIRED', 'Expired');
    }
    return delta;
  });
  await sync.run(scope, new AbortController().signal);
  expired = true;
  await sync.run(scope, new AbortController().signal);
  expect(starts).toBe(2);
  expect(db.allProducts(scope)).toHaveLength(1);
});

it('rejects non-advancing has_more cursors instead of looping forever', async () => {
  const { db, sync } = setup(async (path) => {
    if (path.includes('/sync-start?'))
      return { cursor: 'base', scale_profile: profile };
    if (path.includes('/page?')) return { products: [], next_cursor: null };
    return { ...delta, cursor: 'base', has_more: true };
  });
  await expect(sync.run(scope, new AbortController().signal)).rejects.toThrow();
  expect(db.getState(scope).sync.lastSyncedAt).toBeNull();
});

it('honors server cooldown before a manual retry', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const { sync } = setup(async () => {
      calls++;
      throw new CatalogApiError(429, 'RATE_LIMIT', 'Slow down', 30_000);
    });
    await expect(
      sync.run(scope, new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      sync.run(scope, new AbortController().signal),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    vi.advanceTimersByTime(30_001);
    await expect(
      sync.run(scope, new AbortController().signal),
    ).rejects.toThrow();
    expect(calls).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
