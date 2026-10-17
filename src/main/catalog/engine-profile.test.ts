// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type {
  CatalogProduct,
  ClearPluConfirmation,
  ScaleBarcodeProfile,
  UploadPreview,
} from '../../shared/catalog';
import * as probes from '../diagnostics/probes';
import { issueGrant } from './access';
import { CatalogDatabase } from './database';
import { CatalogEngine } from './engine';

const scope = {
  apiUrl: 'https://api.example.test',
  userId: '00000000-0000-4000-8000-000000000001',
  membershipId: '00000000-0000-4000-8000-000000000002',
  organizationId: '00000000-0000-4000-8000-000000000003',
  storeId: '00000000-0000-4000-8000-000000000004',
  storeName: 'Shop',
};
const profile: ScaleBarcodeProfile = {
  format: 'ean13-weight-v1',
  prefix: '05',
  enabled: true,
  blocked_reason: null,
  revision: 1,
  issued_plu_ranges: [[4245, 4246]],
};
const product: CatalogProduct = {
  id: '00000000-0000-4000-8000-000000000005',
  organization_id: scope.organizationId,
  store_id: scope.storeId,
  name: 'APPLE',
  scale_name: 'TEST APPLE',
  scale_plu: 4245,
  barcode: '2763189',
  unit: 'kg',
  retail_price: '12.34',
  is_active: true,
  updated_at: '2026-10-15T00:00:00Z',
};
const device = {
  scaleIp: '192.168.1.8',
  localAddress: '192.168.1.2',
  port: 5001,
  nameEncoding: 'ascii' as const,
  barcodePrefix: '05',
  profileRevision: 1,
  setupConfirmed: true,
};
const instances: { db: CatalogDatabase; engine: CatalogEngine }[] = [];
beforeEach(() => {
  vi.spyOn(probes, 'getNetworkAdapters').mockReturnValue([
    {
      name: 'Ethernet',
      address: device.localAddress,
      netmask: '255.255.255.0',
      mac: '00:11:22:33:44:55',
    },
  ]);
});
afterEach(async () => {
  for (const { engine, db } of instances.splice(0)) {
    await engine.close();
    db.close();
  }
  vi.restoreAllMocks();
});

function setup(
  options: Partial<ConstructorParameters<typeof CatalogEngine>[1]> = {},
): { db: CatalogDatabase; engine: CatalogEngine } {
  const db = new CatalogDatabase(':memory:');
  db.beginSnapshot(scope, 'base', profile);
  db.applyPage(scope, [product], null);
  db.applyChanges(scope, {
    products: [],
    deleted_ids: [],
    cursor: 'done',
    has_more: false,
    scale_profile: profile,
  });
  db.finishSync(scope, '2026-10-15T00:00:00Z');
  db.saveDevice(scope, device);
  const engine = new CatalogEngine(db, {
    apiUrl: scope.apiUrl,
    grant: issueGrant(scope),
    persistGrant: async () => true,
    ...options,
  });
  instances.push({ db, engine });
  return { db, engine };
}

it.each([
  { ...profile, prefix: '27', revision: 2 },
  { ...profile, revision: 3 },
])(
  'stops an in-flight upload immediately when a verified connection updates profile %j',
  async (nextProfile) => {
    let uploadSignal: AbortSignal | undefined;
    const { db, engine } = setup({
      fetcher: async (input) => {
        const path = new URL(String(input)).pathname;
        const data = path.endsWith('/users/me')
          ? { user: { id: scope.userId } }
          : path.endsWith('/auth/context')
            ? {
                context: {
                  userOrganizationId: scope.membershipId,
                  organizationId: scope.organizationId,
                  storeId: scope.storeId,
                  storeScope: {
                    stores: [{ id: scope.storeId, name: scope.storeName }],
                  },
                },
              }
            : path.endsWith('/sync-start')
              ? { cursor: 'new', scale_profile: nextProfile }
              : {
                  products: [],
                  deleted_ids: [],
                  categories_changed: false,
                  cursor: 'new-done',
                  has_more: false,
                  scale_profile: nextProfile,
                };
        return new Response(JSON.stringify({ data }));
      },
      runUpload: async (job, signal, persist) => {
        uploadSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        const cancelled = {
          ...job,
          status: 'cancelled' as const,
          finishedAt: new Date().toISOString(),
        };
        await persist(cancelled);
        return cancelled;
      },
    });
    const preview = (await engine.request({
      type: 'preview',
    })) as UploadPreview;
    await engine.request({
      type: 'upload',
      revision: preview.revision,
      confirmUncertain: false,
    });
    expect(uploadSignal?.aborted).toBe(false);
    await engine.request({ type: 'connect', accessToken: 'new-token' });
    expect(uploadSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(engine.isUploading()).toBe(false));
    expect(db.getLatestUpload(scope)).toMatchObject({
      profileRevision: 1,
      status: 'cancelled',
    });
    expect(engine.state().device?.setupConfirmed).toBe(false);
    expect(
      (
        (await engine.request({ type: 'preview' })) as UploadPreview
      ).blockers.join(' '),
    ).toContain('настрой');
  },
);

it('rejects confirmation from a stale revision even when the prefix stayed the same', async () => {
  const { db, engine } = setup();
  db.saveProfile(scope, { ...profile, revision: 2 });
  await expect(engine.request({ type: 'save-device', device })).rejects.toThrow(
    'измен',
  );
  await engine.request({
    type: 'save-device',
    device: { ...device, profileRevision: 2 },
  });
  expect(engine.state().device).toMatchObject({
    setupConfirmed: true,
    profileRevision: 2,
  });
  expect(
    (
      (await engine.request({ type: 'preview' })) as UploadPreview
    ).blockers.join(' '),
  ).toContain('синхронизац');
});

it.each([
  { ...profile, enabled: false, revision: 2 },
  { ...profile, prefix: null, revision: 2 },
])(
  'blocks new uploads with disabled or unassigned profile %j',
  async (nextProfile) => {
    const { db, engine } = setup();
    db.saveProfile(scope, nextProfile);
    const preview = (await engine.request({
      type: 'preview',
    })) as UploadPreview;
    expect(preview.blockers.length).toBeGreaterThan(0);
    await expect(
      engine.request({
        type: 'upload',
        revision: preview.revision,
        confirmUncertain: false,
      }),
    ).rejects.toThrow();
    expect(db.getLatestUpload(scope)).toBeNull();
  },
);

it.each(['deleted', 'inactive', 'no-price'] as const)(
  'requires confirmed clear-all before reloading a %s device record',
  async (change) => {
    const { db, engine } = setup({
      runUpload: async (job, _signal, persist) => {
        const completed = {
          ...job,
          status: 'completed' as const,
          finishedAt: new Date().toISOString(),
          items: job.items.map((item) => ({
            ...item,
            state: 'acknowledged' as const,
          })),
        };
        await persist(completed);
        return completed;
      },
      runClearPlu: async (job, _signal, persist) => {
        const completed = {
          ...job,
          status: 'completed' as const,
          commandState: 'acknowledged' as const,
          finishedAt: new Date().toISOString(),
        };
        await persist(completed);
        return completed;
      },
    });
    const first = (await engine.request({ type: 'preview' })) as UploadPreview;
    await engine.request({
      type: 'upload',
      revision: first.revision,
      confirmUncertain: false,
    });
    await vi.waitFor(() => expect(engine.isUploading()).toBe(false));
    const remaining = {
      ...product,
      id: '00000000-0000-4000-8000-000000000006',
      scale_plu: 4246,
    };
    db.applyChanges(scope, {
      products: [
        remaining,
        ...(change === 'deleted'
          ? []
          : [
              {
                ...product,
                ...(change === 'inactive'
                  ? { is_active: false }
                  : { retail_price: null }),
              },
            ]),
      ],
      deleted_ids: change === 'deleted' ? [product.id] : [],
      cursor: 'changed',
      has_more: false,
      scale_profile: profile,
    });
    db.finishSync(scope, '2026-10-15T01:00:00Z');
    const stale = (await engine.request({ type: 'preview' })) as UploadPreview;
    expect(stale.removalRequired).toMatchObject([{ plu: 4245 }]);
    expect(stale.blockers.join(' ')).toContain('очист');
    await expect(
      engine.request({
        type: 'upload',
        revision: stale.revision,
        confirmUncertain: false,
      }),
    ).rejects.toThrow('очист');
    const { token } = (await engine.request({
      type: 'prepare-clear',
    })) as ClearPluConfirmation;
    await engine.request({ type: 'clear-products', token });
    await vi.waitFor(() => expect(engine.isUploading()).toBe(false));
    const clean = (await engine.request({ type: 'preview' })) as UploadPreview;
    expect(clean.removalRequired).toEqual([]);
    expect(clean.blockers).toEqual([]);
    await engine.request({
      type: 'upload',
      revision: clean.revision,
      confirmUncertain: false,
    });
    await vi.waitFor(() => expect(engine.isUploading()).toBe(false));
    expect(
      db.getLatestUpload(scope)?.items.map((item) => item.product.scale_plu),
    ).toEqual([4246]);
  },
);

it('requires a full reload after changing the profile and clears the requirement only after completion', async () => {
  const { db, engine } = setup({
    runUpload: async (job, _signal, persist) => {
      const done = {
        ...job,
        status: 'completed' as const,
        finishedAt: new Date().toISOString(),
        items: job.items.map((item) => ({
          ...item,
          state: 'acknowledged' as const,
        })),
      };
      await persist(done);
      return done;
    },
  });
  const next = { ...profile, prefix: '27', revision: 2 };
  db.applyChanges(scope, {
    products: [
      {
        ...product,
        id: '00000000-0000-4000-8000-000000000006',
        scale_plu: 4246,
      },
    ],
    deleted_ids: [],
    cursor: 'new-profile',
    has_more: false,
    scale_profile: next,
  });
  db.finishSync(scope, '2026-10-15T02:00:00Z');
  await engine.request({
    type: 'save-device',
    device: { ...device, barcodePrefix: '27', profileRevision: 2 },
  });
  const partial = (await engine.request({
    type: 'preview',
    productIds: [product.id],
  })) as UploadPreview;
  expect(partial.blockers.join(' ')).toContain('весь каталог');
  const full = (await engine.request({ type: 'preview' })) as UploadPreview;
  expect(full.blockers).toEqual([]);
  await engine.request({
    type: 'upload',
    revision: full.revision,
    confirmUncertain: false,
  });
  await vi.waitFor(() => expect(engine.isUploading()).toBe(false));
  expect(db.getDevice(scope)).toMatchObject({ reloadRequired: false });
  expect(
    (
      (await engine.request({
        type: 'preview',
        productIds: [product.id],
      })) as UploadPreview
    ).blockers,
  ).toEqual([]);
});

it('can complete a required reload of more than 10000 products in explicitly selected batches', async () => {
  const { db, engine } = setup({
    runUpload: async (job, _signal, persist) => {
      const done = {
        ...job,
        status: 'completed' as const,
        finishedAt: new Date().toISOString(),
        items: job.items.map((item) => ({
          ...item,
          state: 'acknowledged' as const,
        })),
      };
      await persist(done);
      return done;
    },
  });
  const next = {
    ...profile,
    prefix: '27',
    revision: 2,
    issued_plu_ranges: [[1, 10001]] as [number, number][],
  };
  const products = Array.from({ length: 10001 }, (_, index) => ({
    ...product,
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
    scale_plu: index + 1,
  }));
  db.beginSnapshot(scope, 'large', next);
  db.applyPage(scope, products, null);
  db.applyChanges(scope, {
    products: [],
    deleted_ids: [],
    cursor: 'large-done',
    has_more: false,
    scale_profile: next,
  });
  db.finishSync(scope, '2026-10-16T00:00:00Z');
  await engine.request({
    type: 'save-device',
    device: { ...device, barcodePrefix: '27', profileRevision: 2 },
  });
  for (const batch of [products.slice(0, 10000), products.slice(10000)]) {
    const productIds = batch.map((item) => item.id);
    const preview = (await engine.request({
      type: 'preview',
      productIds,
    })) as UploadPreview;
    expect(preview.blockers).toEqual([]);
    await engine.request({
      type: 'upload',
      revision: preview.revision,
      productIds,
      confirmUncertain: false,
    });
    await vi.waitFor(() => expect(engine.isUploading()).toBe(false), {
      timeout: 10000,
    });
    expect(db.getDevice(scope)?.reloadRequired).toBe(batch.length === 10000);
  }
}, 30000);

it.each(['deleted', 'inactive', 'no-price', 'price', 'unchanged'] as const)(
  'revalidates an upload after a %s catalog commit without stopping unchanged data',
  async (change) => {
    let signal: AbortSignal | undefined;
    const { db, engine } = setup({
      fetcher: async (input) => {
        const path = new URL(String(input)).pathname;
        const data = path.endsWith('/users/me')
          ? { user: { id: scope.userId } }
          : path.endsWith('/auth/context')
            ? {
                context: {
                  userOrganizationId: scope.membershipId,
                  organizationId: scope.organizationId,
                  storeId: scope.storeId,
                  storeScope: {
                    stores: [{ id: scope.storeId, name: scope.storeName }],
                  },
                },
              }
            : path.endsWith('/sync-start')
              ? { cursor: 'new', scale_profile: profile }
              : {
                  products: [],
                  deleted_ids: [],
                  categories_changed: false,
                  cursor: 'checked',
                  has_more: false,
                  scale_profile: profile,
                };
        return new Response(JSON.stringify({ data }));
      },
      runUpload: async (job, cancellation, persist) => {
        signal = cancellation;
        await new Promise<void>((resolve) =>
          cancellation.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        const done = {
          ...job,
          status: 'cancelled' as const,
          finishedAt: new Date().toISOString(),
        };
        await persist(done);
        return done;
      },
    });
    const preview = (await engine.request({
      type: 'preview',
    })) as UploadPreview;
    await engine.request({
      type: 'upload',
      revision: preview.revision,
      confirmUncertain: false,
    });
    db.applyChanges(scope, {
      products:
        change === 'deleted' || change === 'unchanged'
          ? []
          : [
              {
                ...product,
                ...(change === 'inactive'
                  ? { is_active: false }
                  : change === 'no-price'
                    ? { retail_price: null }
                    : { retail_price: '20.00' }),
              },
            ],
      deleted_ids: change === 'deleted' ? [product.id] : [],
      cursor: 'updated',
      has_more: false,
      scale_profile: profile,
    });
    db.finishSync(scope, '2026-10-15T03:00:00Z');
    await engine.request({ type: 'connect', accessToken: 'token' });
    expect(signal?.aborted).toBe(change !== 'unchanged');
  },
);
