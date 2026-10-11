// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CatalogProduct,
  ClearPluConfirmation,
  ClearPluJob,
  UploadPreview,
} from '../../shared/catalog';
import * as probes from '../diagnostics/probes';
import type { runUpload as uploadRunner } from '../scales/upload';
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
const profile = {
  format: 'ean13-weight-v1',
  prefix: '21',
  enabled: true,
  blocked_reason: null,
} as const;
const directories: string[] = [];
const databases: CatalogDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
  directories
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe('explicit device product clearing', () => {
  const device = {
    scaleIp: '192.168.1.8',
    localAddress: '192.168.1.2',
    port: 5001,
    nameEncoding: 'ascii' as const,
    barcodePrefix: '21',
    setupConfirmed: false,
  };
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
  const completed = async (
    job: ClearPluJob,
    _signal: AbortSignal,
    persist: (job: ClearPluJob) => Promise<void>,
  ): Promise<ClearPluJob> => {
    const result: ClearPluJob = {
      ...job,
      commandState: 'acknowledged',
      status: 'completed',
      finishedAt: new Date().toISOString(),
    };
    await persist(result);
    return result;
  };

  it('requires a one-use device confirmation without requiring a catalog or label setup', async () => {
    const runClearPlu = vi.fn(completed);
    const { engine, db } = setup({ grant: issueGrant(scope), runClearPlu });
    db.saveDevice(scope, device);
    await expect(
      engine.request({ type: 'clear-products', token: 'arbitrary' }),
    ).rejects.toThrow();
    const confirmation = (await engine.request({
      type: 'prepare-clear',
    })) as ClearPluConfirmation;
    expect(confirmation.device).toEqual(device);
    expect(runClearPlu).not.toHaveBeenCalled();
    await engine.request({ type: 'clear-products', token: confirmation.token });
    await vi.waitFor(() => expect(engine.isUploading()).toBe(false));
    expect(db.getLatestClear(scope)?.commandState).toBe('acknowledged');
    expect(engine.state().latestClear?.device).toEqual(device);
    await expect(
      engine.request({ type: 'clear-products', token: confirmation.token }),
    ).rejects.toThrow();
    expect(runClearPlu).toHaveBeenCalledTimes(1);
    expect(db.getState(scope).sync.lastSyncedAt).toBeNull();
    await engine.close();
  });

  it('rejects an expired confirmation or a changed target before network work', async () => {
    const runClearPlu = vi.fn(completed);
    const { engine, db } = setup({ grant: issueGrant(scope), runClearPlu });
    db.saveDevice(scope, device);
    const first = (await engine.request({
      type: 'prepare-clear',
    })) as ClearPluConfirmation;
    db.saveDevice(scope, { ...device, port: 5002 });
    await expect(
      engine.request({ type: 'clear-products', token: first.token }),
    ).rejects.toThrow();
    const second = (await engine.request({
      type: 'prepare-clear',
    })) as ClearPluConfirmation;
    vi.spyOn(Date, 'now').mockReturnValue(
      new Date(second.expiresAt).getTime() + 1,
    );
    await expect(
      engine.request({ type: 'clear-products', token: second.token }),
    ).rejects.toThrow();
    expect(runClearPlu).not.toHaveBeenCalled();
    await engine.close();
  });

  it('does not start clearing if the durable job cannot be saved', async () => {
    const runClearPlu = vi.fn(completed);
    const { engine, db } = setup({ grant: issueGrant(scope), runClearPlu });
    db.saveDevice(scope, device);
    const { token } = (await engine.request({
      type: 'prepare-clear',
    })) as ClearPluConfirmation;
    vi.spyOn(db, 'saveClear').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(
      engine.request({ type: 'clear-products', token }),
    ).rejects.toThrow('disk full');
    expect(runClearPlu).not.toHaveBeenCalled();
    expect(engine.isUploading()).toBe(false);
    await engine.close();
  });

  it('locks device operations while clearing and awaits cancellation on close', async () => {
    const runClearPlu = vi.fn(
      async (
        job: ClearPluJob,
        signal: AbortSignal,
        persist: (job: ClearPluJob) => Promise<void>,
      ) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        const result: ClearPluJob = {
          ...job,
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
        };
        await persist(result);
        return result;
      },
    );
    const { engine, db } = setup({ grant: issueGrant(scope), runClearPlu });
    db.saveDevice(scope, device);
    const { token } = (await engine.request({
      type: 'prepare-clear',
    })) as ClearPluConfirmation;
    await engine.request({ type: 'clear-products', token });
    expect(engine.isUploading()).toBe(true);
    await expect(engine.request({ type: 'prepare-clear' })).rejects.toThrow();
    await expect(
      engine.request({ type: 'save-device', device }),
    ).rejects.toThrow();
    expect(
      ((await engine.request({ type: 'preview' })) as UploadPreview).blockers,
    ).toContain('Другая операция с весами ещё выполняется.');
    await engine.close();
    expect(db.getLatestClear(scope)?.status).toBe('cancelled');
    expect(engine.isUploading()).toBe(false);
  });
});

// Test fixture returns the concrete mocked collaborators for failure injection.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(
  extra: Partial<ConstructorParameters<typeof CatalogEngine>[1]> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'scales-engine-'));
  directories.push(directory);
  const db = new CatalogDatabase(join(directory, 'catalog.sqlite'));
  databases.push(db);
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const data = url.pathname.endsWith('/users/me')
      ? { user: { id: scope.userId } }
      : url.pathname.endsWith('/auth/context')
        ? {
            context: {
              userOrganizationId: scope.membershipId,
              organizationId: scope.organizationId,
              storeId: scope.storeId,
              storeScope: { stores: [{ id: scope.storeId, name: 'Shop' }] },
            },
          }
        : url.pathname.endsWith('/sync-start')
          ? { cursor: 'base', scale_profile: profile }
          : url.pathname.endsWith('/page')
            ? { products: [], next_cursor: null }
            : {
                products: [],
                deleted_ids: [],
                categories_changed: false,
                cursor: 'done',
                has_more: false,
                scale_profile: profile,
              };
    return new Response(JSON.stringify({ data }));
  });
  const persistGrant = vi.fn(async () => true);
  const engine = new CatalogEngine(db, {
    apiUrl: scope.apiUrl,
    fetcher,
    persistGrant,
    ...extra,
  });
  return { engine, db, fetcher, persistGrant };
}

describe('catalog access and upload orchestration', () => {
  it('restores local access without network and revokes it on disconnect', async () => {
    const { engine, fetcher, persistGrant } = setup({
      grant: issueGrant(scope),
    });
    expect(engine.state().access).toBe('offline');
    expect(fetcher).not.toHaveBeenCalled();
    await engine.request({ type: 'disconnect' });
    expect(engine.state().scope).toBeNull();
    expect(persistGrant).toHaveBeenCalledWith(null);
    await expect(
      engine.request({ type: 'list', search: '', offset: 0 }),
    ).rejects.toThrow();
  });

  it('does not accept an expired cached grant', () => {
    const { engine } = setup({
      grant: issueGrant(scope, Date.now() - 9 * 3600_000),
    });
    expect(engine.state().access).toBe('none');
  });

  it('rejects a late verification after logout', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { engine } = setup({
      fetcher: async () => {
        await wait;
        return new Response('{}');
      },
    });
    const connecting = engine.request({
      type: 'connect',
      accessToken: 'token',
    });
    await engine.request({ type: 'disconnect' });
    release();
    await expect(connecting).rejects.toThrow();
    expect(engine.state().access).toBe('none');
  });

  it('blocks upload without a complete snapshot and explicit device setup', async () => {
    const runUpload = vi.fn();
    const { engine } = setup({ grant: issueGrant(scope), runUpload });
    await expect(
      engine.request({ type: 'upload', confirmUncertain: false, revision: '' }),
    ).rejects.toThrow();
    expect(runUpload).not.toHaveBeenCalled();
  });

  it('revokes cached access when a verified refresh has lost the store context', async () => {
    const { engine, fetcher } = setup({ grant: issueGrant(scope) });
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) =>
      String(args[0]).includes('/auth/context')
        ? new Response(
            JSON.stringify({
              data: { context: { storeId: null, storeScope: { stores: [] } } },
            }),
          )
        : original(...args),
    );
    await expect(
      engine.request({ type: 'connect', accessToken: 'new-token' }),
    ).rejects.toThrow();
    expect(engine.state().scope).toBeNull();
  });

  it('exposes newly blocked profile metadata while the old product snapshot remains active', async () => {
    const { engine, db } = setup({ grant: issueGrant(scope) });
    db.beginSnapshot(scope, 'base', profile);
    db.applyPage(scope, [], null);
    db.applyChanges(scope, {
      products: [],
      deleted_ids: [],
      cursor: 'done',
      has_more: false,
      scale_profile: profile,
    });
    db.finishSync(scope, new Date().toISOString());
    db.applyChanges(scope, {
      products: [],
      deleted_ids: [],
      cursor: 'pending',
      has_more: false,
      waiting_for_transactions: true,
      scale_profile: { ...profile, enabled: false },
    });
    expect(engine.state().profile?.enabled).toBe(false);
    const preview = (await engine.request({ type: 'preview' })) as {
      blockers: string[];
    };
    expect(preview.blockers.join(' ')).toContain('Включите профиль');
  });

  it('keeps manual synchronization cancellation paused during later ticks', async () => {
    const { engine, fetcher } = setup();
    await engine.request({ type: 'connect', accessToken: 'token' });
    await engine.request({ type: 'cancel-sync' });
    fetcher.mockClear();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    try {
      await engine.tick();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      await engine.close();
    }
  });

  it('only grants access after verifying catalog permission', async () => {
    const { engine, fetcher, persistGrant } = setup();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) =>
      String(args[0]).includes('sync-start')
        ? new Response(
            JSON.stringify({ error_code: 'INSUFFICIENT_PERMISSIONS' }),
            { status: 403 },
          )
        : original(...args),
    );
    await expect(
      engine.request({ type: 'connect', accessToken: 'token' }),
    ).rejects.toThrow();
    expect(engine.state().access).toBe('none');
    expect(persistGrant).not.toHaveBeenCalledWith(
      expect.objectContaining({ scope }),
    );
  });

  it('requests one token refresh on verification 401 and keeps the valid offline grant', async () => {
    const refreshRequired = vi.fn();
    const { engine, persistGrant } = setup({
      grant: issueGrant(scope),
      refreshRequired,
      fetcher: async () => new Response('{}', { status: 401 }),
    });
    await expect(
      engine.request({ type: 'connect', accessToken: 'expired' }),
    ).rejects.toThrow();
    expect(refreshRequired).toHaveBeenCalledTimes(1);
    expect(engine.state().access).toBe('offline');
    expect(engine.state().scope).toEqual(scope);
    expect(persistGrant).not.toHaveBeenCalledWith(null);
    await expect(
      engine.request({ type: 'connect', accessToken: 'rejected-refresh' }),
    ).rejects.toThrow();
    expect(refreshRequired).toHaveBeenCalledTimes(1);
    // A failed network refresh must remain recoverable through an explicit retry.
    await engine.request({ type: 'sync' });
    expect(refreshRequired).toHaveBeenCalledTimes(2);
    expect(engine.state().scope).toEqual(scope);
    await engine.request({ type: 'disconnect' });
    expect(engine.state().scope).toBeNull();
    await engine.close();
  });

  it('retains the unavailable secure storage warning after successful synchronization', async () => {
    const { engine } = setup({ persistGrant: async () => false });
    await engine.request({ type: 'connect', accessToken: 'token' });
    await vi.waitFor(() => expect(engine.state().sync.running).toBe(false));
    expect(engine.state().sync.lastSyncedAt).not.toBeNull();
    expect(engine.state().error).toContain('Защищённое хранилище недоступно');
    await engine.close();
  });

  it('waits for pending grant persistence before closing and does not resume work', async () => {
    let release!: (value: boolean) => void;
    const persistGrant = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const changed = vi.fn();
    const { engine, fetcher } = setup({ persistGrant, changed });
    const connecting = engine.request({
      type: 'connect',
      accessToken: 'token',
    });
    const rejected = expect(connecting).rejects.toThrow();
    await vi.waitFor(() => expect(persistGrant).toHaveBeenCalledTimes(1));
    const closed = vi.fn();
    const closing = engine.close().then(closed);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).not.toHaveBeenCalled();
    release(true);
    await rejected;
    await closing;
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(changed).not.toHaveBeenCalled();
    expect(engine.state().scope).toBeNull();
  });

  it('requires a fresh preview and uploads the persisted local snapshot only on explicit request', async () => {
    vi.spyOn(probes, 'getNetworkAdapters').mockReturnValue([
      {
        name: 'Ethernet',
        address: '192.168.1.2',
        netmask: '255.255.255.0',
        mac: '00:11:22:33:44:55',
      },
    ]);
    const runUpload = vi.fn<typeof uploadRunner>(
      async (job, _signal, persist) => {
        const completed = {
          ...job,
          items: job.items.map((item) => ({
            ...item,
            state: 'acknowledged' as const,
          })),
          status: 'completed' as const,
          finishedAt: new Date().toISOString(),
        };
        await persist(completed);
        return completed;
      },
    );
    const { engine, db } = setup({ grant: issueGrant(scope), runUpload });
    const product: CatalogProduct = {
      id: '00000000-0000-4000-8000-000000000005',
      organization_id: scope.organizationId,
      store_id: scope.storeId,
      name: 'APPLE',
      scale_name: null,
      scale_plu: 1,
      barcode: '',
      unit: 'kg',
      retail_price: '12.34',
      is_active: true,
      updated_at: new Date().toISOString(),
    };
    db.beginSnapshot(scope, 'base', profile);
    db.applyPage(scope, [product], null);
    db.applyChanges(scope, {
      products: [],
      deleted_ids: [],
      cursor: 'first',
      has_more: false,
      scale_profile: profile,
    });
    db.finishSync(scope, new Date().toISOString());
    await engine.request({
      type: 'save-device',
      device: {
        scaleIp: '192.168.1.8',
        localAddress: '192.168.1.2',
        port: 5001,
        nameEncoding: 'ascii',
        barcodePrefix: '21',
        setupConfirmed: true,
      },
    });
    const oldPreview = (await engine.request({
      type: 'preview',
    })) as UploadPreview;
    expect(oldPreview.blockers).toEqual([]);
    expect(runUpload).not.toHaveBeenCalled();
    db.applyChanges(scope, {
      products: [{ ...product, retail_price: '15.67' }],
      deleted_ids: [],
      cursor: 'second',
      has_more: false,
      scale_profile: profile,
    });
    db.finishSync(scope, new Date().toISOString());
    await expect(
      engine.request({
        type: 'upload',
        revision: oldPreview.revision,
        confirmUncertain: false,
      }),
    ).rejects.toThrow('Данные изменились');
    expect(runUpload).not.toHaveBeenCalled();
    const currentPreview = (await engine.request({
      type: 'preview',
    })) as UploadPreview;
    await engine.request({
      type: 'upload',
      revision: currentPreview.revision,
      confirmUncertain: false,
    });
    await vi.waitFor(() => expect(engine.isUploading()).toBe(false));
    expect(runUpload).toHaveBeenCalledTimes(1);
    const saved = db.getLatestUpload(scope)!;
    expect(saved.status).toBe('completed');
    expect(saved.items[0].product.retail_price).toBe('15.67');
    expect(saved.items[0].state).toBe('acknowledged');
    expect(Buffer.from(saved.items[0].packetHex, 'hex')).toHaveLength(261);
    await engine.close();
  });
});
