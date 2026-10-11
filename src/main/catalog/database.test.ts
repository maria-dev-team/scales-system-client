// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';

import type {
  CatalogProduct,
  CatalogScope,
  ClearPluJob,
  ScaleBarcodeProfile,
  UploadJob,
} from '../../shared/catalog';
import { CatalogDatabase } from './database';

const scope: CatalogScope = {
  apiUrl: 'https://api.test/v1',
  userId: 'user',
  membershipId: 'member',
  organizationId: 'org',
  storeId: 'store',
  storeName: 'Shop',
};
const profile: ScaleBarcodeProfile = {
  format: 'ean13-weight-v1',
  prefix: '21',
  enabled: true,
  blocked_reason: null,
};
const product: CatalogProduct = {
  id: 'apple',
  organization_id: 'org',
  store_id: 'store',
  name: 'Яблоки',
  scale_name: null,
  scale_plu: 1,
  barcode: '123',
  unit: 'kg',
  retail_price: '100.00',
  is_active: true,
  updated_at: '2026-10-11T00:00:00Z',
};
const uploadJob = (
  id: string,
  state: UploadJob['items'][number]['state'] = 'pending',
): UploadJob => ({
  id,
  scope,
  device: {
    scaleIp: '192.168.1.8',
    localAddress: '192.168.1.9',
    port: 5000,
    nameEncoding: 'ascii',
    barcodePrefix: '21',
    setupConfirmed: true,
  },
  catalogSyncedAt: '2026-10-11T00:00:00Z',
  createdAt: '2026-10-11T01:00:00Z',
  finishedAt: null,
  status: 'running',
  items: [{ product, packetHex: '00', state, error: null }],
  events: [],
  error: null,
  disconnectError: null,
});
const clearJob = (
  id: string,
  commandState: ClearPluJob['commandState'] = 'pending',
): ClearPluJob => ({
  id,
  scope,
  device: uploadJob('device').device,
  createdAt: '2026-10-11T02:00:00Z',
  finishedAt: null,
  status: 'running',
  commandState,
  events: [
    {
      at: '2026-10-11T02:00:01Z',
      phase: 'clear:planned',
      kind: 'tx',
      hex: 'abcd',
    },
  ],
  error: null,
  disconnectError: null,
});
const directories: string[] = [];
const databases: CatalogDatabase[] = [];
const open = (path?: string): { db: CatalogDatabase; path: string } => {
  if (!path) {
    const directory = mkdtempSync(join(tmpdir(), 'scales-catalog-'));
    directories.push(directory);
    path = join(directory, 'catalog.sqlite');
  }
  const db = new CatalogDatabase(path);
  databases.push(db);
  return { db, path };
};
const complete = (db: CatalogDatabase, products = [product]): void => {
  db.beginSnapshot(scope, 'baseline', profile);
  db.applyPage(scope, products, null);
  db.applyChanges(scope, {
    products: [],
    deleted_ids: [],
    cursor: 'done',
    has_more: false,
    scale_profile: profile,
  });
  db.finishSync(scope, '2026-10-11T01:00:00Z');
};
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});

it('keeps the active catalog across a restart until staged pages and catchup commit', () => {
  const first = open();
  complete(first.db);
  first.db.beginSnapshot(scope, 'next-base', { ...profile, prefix: '22' });
  first.db.applyPage(scope, [{ ...product, retail_price: '200.00' }], 'apple');
  first.db.close();
  databases.splice(databases.indexOf(first.db), 1);
  const { db } = open(first.path);
  expect(db.allProducts(scope)[0].retail_price).toBe('100.00');
  expect(db.getState(scope).profile?.prefix).toBe('21');
  expect(db.getProgress(scope)).toMatchObject({
    after: 'apple',
    cursor: 'next-base',
    phase: 'pages',
  });
  db.applyPage(scope, [], null);
  db.applyChanges(scope, {
    products: [],
    deleted_ids: [],
    cursor: 'next',
    has_more: false,
    scale_profile: { ...profile, prefix: '22' },
  });
  db.finishSync(scope, '2026-10-11T02:00:00Z');
  expect(db.allProducts(scope)[0].retail_price).toBe('200.00');
  expect(db.getState(scope).profile?.prefix).toBe('22');
});

it('rolls back products and cursor together when SQLite rejects part of a delta', () => {
  const { db, path } = open();
  complete(db);
  const connection = new DatabaseSync(path);
  connection.exec(
    "CREATE TRIGGER reject_bad BEFORE INSERT ON catalog_products WHEN NEW.id='bad' BEGIN SELECT RAISE(ABORT,'disk-like failure'); END;",
  );
  connection.close();
  expect(() =>
    db.applyChanges(scope, {
      products: [
        { ...product, retail_price: '900.00' },
        { ...product, id: 'bad' },
      ],
      deleted_ids: [],
      cursor: 'not-committed',
      has_more: false,
      scale_profile: profile,
    }),
  ).toThrow();
  expect(db.allProducts(scope)[0].retail_price).toBe('100.00');
  expect(db.getProgress(scope)?.cursor).toBe('done');
});

it('keeps the previous complete catalog visible during an interrupted multi-page delta', () => {
  const { db, path } = open();
  complete(db);
  db.applyChanges(scope, {
    products: [{ ...product, retail_price: '500.00' }],
    deleted_ids: [],
    cursor: 'partial',
    has_more: true,
    scale_profile: { ...profile, prefix: '22' },
  });
  expect(db.allProducts(scope)[0].retail_price).toBe('100.00');
  expect(db.getState(scope).profile?.prefix).toBe('21');
  db.close();
  databases.splice(databases.indexOf(db), 1);
  const resumed = open(path).db;
  expect(resumed.getProgress(scope)?.cursor).toBe('partial');
  expect(resumed.allProducts(scope)[0].retail_price).toBe('100.00');
  resumed.applyChanges(scope, {
    products: [],
    deleted_ids: [],
    cursor: 'complete',
    has_more: false,
    scale_profile: { ...profile, prefix: '22' },
  });
  resumed.finishSync(scope, '2026-10-11T03:00:00Z');
  expect(resumed.allProducts(scope)[0].retail_price).toBe('500.00');
  expect(resumed.getState(scope).profile?.prefix).toBe('22');
});

it('isolates catalog data by API, user, membership, organization and store', () => {
  const { db } = open();
  complete(db);
  for (const field of [
    'apiUrl',
    'userId',
    'membershipId',
    'organizationId',
    'storeId',
  ] as const) {
    expect(db.allProducts({ ...scope, [field]: 'other' })).toEqual([]);
  }
  expect(
    db.listProducts({ ...scope, storeName: 'Renamed' }, 'ЯБЛ', 0).total,
  ).toBe(1);
});

it('applies deletions atomically and never activates a waiting snapshot', () => {
  const { db } = open();
  complete(db);
  db.beginSnapshot(scope, 'start', profile);
  db.applyPage(scope, [product], null);
  db.applyChanges(scope, {
    products: [],
    deleted_ids: [product.id],
    cursor: 'wait',
    has_more: false,
    waiting_for_transactions: true,
    scale_profile: profile,
  });
  expect(() => db.finishSync(scope, '2026-10-11T02:00:00Z')).toThrow();
  expect(db.getState(scope).total).toBe(1);
  expect(db.getState(scope).sync.lastSyncedAt).toBe('2026-10-11T01:00:00Z');
  db.applyChanges(scope, {
    products: [],
    deleted_ids: [],
    cursor: 'clear',
    has_more: false,
    scale_profile: profile,
  });
  db.finishSync(scope, '2026-10-11T02:00:00Z');
  expect(db.getState(scope).total).toBe(0);
});

it('recovers an interrupted upload without pretending an in-flight product failed to reach the scales', () => {
  const { db, path } = open();
  const job: UploadJob = {
    id: 'job',
    scope,
    device: {
      scaleIp: '192.168.1.8',
      localAddress: '192.168.1.9',
      port: 5000,
      nameEncoding: 'ascii',
      barcodePrefix: '21',
      setupConfirmed: true,
    },
    catalogSyncedAt: 'date',
    createdAt: '2026-10-11T01:00:00Z',
    finishedAt: null,
    status: 'running',
    items: [{ product, packetHex: '00', state: 'in_flight', error: null }],
    events: [],
    error: null,
    disconnectError: null,
  };
  db.saveDevice(scope, job.device);
  db.saveUpload(job);
  db.close();
  databases.splice(databases.indexOf(db), 1);
  const reopened = open(path).db;
  expect(reopened.getLatestUpload(scope)).toMatchObject({
    status: 'interrupted',
    items: [{ state: 'uncertain' }],
  });
  expect(reopened.uploadedProducts(scope, job.device)).toEqual([product]);
  expect(reopened.getDevice(scope)).toEqual(job.device);
  expect(reopened.getLatestUpload({ ...scope, userId: 'other' })).toBeNull();
});

const terminalStatuses = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
const interruptedFinalizationCases = terminalStatuses.flatMap((status) =>
  [false, true].map((missingFinishedAt) => ({ status, missingFinishedAt })),
);

it.each(interruptedFinalizationCases)(
  'recovers an upload interrupted during finalization ($status, missing finishedAt: $missingFinishedAt)',
  ({ status, missingFinishedAt }) => {
    const { db, path } = open();
    const job = uploadJob('unfinished-disconnect', 'acknowledged');
    job.status = status;
    job.events = [
      {
        at: job.createdAt,
        phase: 'disconnect:planned',
        kind: 'tx',
        hex: 'abcd',
      },
    ];
    if (status !== 'completed')
      job.items.push({
        ...job.items[0]!,
        product: { ...product, id: 'uncertain-apple', scale_plu: 2 },
        state: 'in_flight',
      });
    db.saveUpload(job);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    if (missingFinishedAt) {
      const legacy = new DatabaseSync(path);
      legacy
        .prepare(
          "UPDATE catalog_uploads SET value=json_remove(value,'$.finishedAt') WHERE id=?",
        )
        .run(job.id);
      legacy.close();
    }
    const reopened = open(path).db;
    const recovered = reopened.getLatestUpload(scope)!;
    expect(recovered).toEqual({
      ...job,
      status: 'interrupted',
      finishedAt: expect.any(String),
      error: expect.stringContaining('Проверьте результат на весах'),
      items: job.items.map((item) => ({
        ...item,
        state: item.state === 'in_flight' ? 'uncertain' : item.state,
      })),
    });
    expect(Number.isFinite(Date.parse(recovered.finishedAt!))).toBe(true);
    expect(reopened.uploadedProducts(scope, job.device)).toEqual(
      job.items.map((item) => item.product),
    );
  },
);

it.each(interruptedFinalizationCases)(
  'recovers a clear interrupted during finalization without losing its ACK or history cutoff ($status, missing finishedAt: $missingFinishedAt)',
  ({ status, missingFinishedAt }) => {
    const { db, path } = open();
    const before = {
      ...uploadJob('before-clear', 'acknowledged'),
      status: 'completed' as const,
      finishedAt: '2026-10-11T01:01:00Z',
    };
    db.saveUpload(before);
    const job = clearJob(
      'unfinished-clear',
      status === 'completed' ? 'acknowledged' : 'in_flight',
    );
    job.status = status;
    db.saveClear(job);
    const later = {
      ...uploadJob('after-clear', 'acknowledged'),
      status: 'completed' as const,
      finishedAt: '2026-10-11T03:00:00Z',
    };
    later.items[0] = {
      ...later.items[0]!,
      product: { ...product, id: 'later-apple', scale_plu: 2 },
    };
    db.saveUpload(later);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    if (missingFinishedAt) {
      const legacy = new DatabaseSync(path);
      legacy
        .prepare(
          "UPDATE catalog_clears SET value=json_remove(value,'$.finishedAt') WHERE id=?",
        )
        .run(job.id);
      legacy.close();
    }
    const reopened = open(path).db;
    const recovered = reopened.getLatestClear(scope)!;
    expect(recovered).toEqual({
      ...job,
      status: 'interrupted',
      commandState: status === 'completed' ? 'acknowledged' : 'uncertain',
      finishedAt: expect.any(String),
      error: expect.stringContaining('Проверьте результат на весах'),
    });
    expect(Number.isFinite(Date.parse(recovered.finishedAt!))).toBe(true);
    expect(reopened.uploadedProducts(scope, job.device)).toEqual(
      status === 'completed'
        ? [later.items[0].product]
        : [product, later.items[0].product],
    );
    expect(reopened.getLatestUpload(scope)).toEqual(later);
  },
);

it.each(terminalStatuses)(
  'does not rewrite finalized %s uploads or clears after restart',
  (status) => {
    const { db, path } = open();
    const upload = {
      ...uploadJob('final-upload', 'acknowledged'),
      status,
      finishedAt: '2026-10-11T01:01:00Z',
      error: status === 'completed' ? null : 'Original upload error',
    };
    const clear = {
      ...clearJob(
        'final-clear',
        status === 'completed' ? 'acknowledged' : 'uncertain',
      ),
      status,
      finishedAt: '2026-10-11T02:01:00Z',
      error: status === 'completed' ? null : 'Original clear error',
    };
    db.saveUpload(upload);
    db.saveClear(clear);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = open(path).db;
    expect(reopened.getLatestUpload(scope)).toEqual(upload);
    expect(reopened.getLatestClear(scope)).toEqual(clear);
  },
);

it('shares possible device contents and unresolved writes across verified users of the same store', () => {
  const { db } = open();
  const uncertain = uploadJob('uncertain', 'uncertain');
  uncertain.status = 'failed';
  db.saveUpload(uncertain);
  db.saveUpload(uploadJob('later-pending'));
  const otherUser = {
    ...scope,
    apiUrl: 'https://API.TEST:443/v1/',
    userId: 'another',
    membershipId: 'another-membership',
  };
  expect(db.uncertainProducts(otherUser, uncertain.device)).toEqual(
    new Set(['apple']),
  );
  expect(
    db.uploadedProducts(otherUser, {
      ...uncertain.device,
      barcodePrefix: '22',
      localAddress: '192.168.1.10',
    }),
  ).toEqual([product]);
  expect(db.getLatestUpload(otherUser)).toBeNull();
  expect(
    db.uploadedProducts({ ...otherUser, storeId: 'other' }, uncertain.device),
  ).toEqual([]);
  const confirmed = uploadJob('confirmed', 'acknowledged');
  confirmed.scope = otherUser;
  confirmed.status = 'completed';
  db.saveUpload(confirmed);
  expect(db.uncertainProducts(scope, uncertain.device)).toEqual(new Set());
});

it('writes only the changed item and appended event during a bulk upload', () => {
  const { db, path } = open();
  const job = uploadJob('bulk');
  job.items = Array.from({ length: 100 }, (_, index) => ({
    ...job.items[0],
    product: { ...product, id: `item-${index}`, scale_plu: index + 1 },
  }));
  db.saveUpload(job);
  const connection = new DatabaseSync(path);
  connection.exec(`CREATE TABLE upload_audit(kind TEXT);
    CREATE TRIGGER audit_item_update AFTER UPDATE ON upload_items BEGIN INSERT INTO upload_audit VALUES('item'); END;
    CREATE TRIGGER audit_item_insert AFTER INSERT ON upload_items BEGIN INSERT INTO upload_audit VALUES('item'); END;
    CREATE TRIGGER audit_event_insert AFTER INSERT ON upload_events BEGIN INSERT INTO upload_audit VALUES('event'); END;
    CREATE TRIGGER audit_header_update AFTER UPDATE ON catalog_uploads BEGIN INSERT INTO upload_audit VALUES('header'); END;`);
  job.items[55].state = 'in_flight';
  job.events.push({
    at: '2026-10-11T01:00:01Z',
    phase: 'write',
    kind: 'tx',
    hex: '00',
  });
  db.saveUpload(job);
  expect(
    connection
      .prepare('SELECT kind FROM upload_audit ORDER BY kind')
      .all()
      .map((row) => row.kind),
  ).toEqual(['event', 'item']);
  expect(db.getLatestUpload(scope)?.items[55].state).toBe('in_flight');
  expect(db.getLatestUpload(scope)?.items).toHaveLength(100);
  connection.close();
});

it('rolls back a failed upload checkpoint and retries it without losing the changed item', () => {
  const { db, path } = open();
  const job = uploadJob('checkpoint');
  db.saveUpload(job);
  const connection = new DatabaseSync(path);
  connection.exec(
    "CREATE TRIGGER reject_event BEFORE INSERT ON upload_events BEGIN SELECT RAISE(ABORT,'cannot persist event'); END;",
  );
  job.items[0].state = 'in_flight';
  job.events.push({
    at: '2026-10-11T01:00:01Z',
    phase: 'write',
    kind: 'tx',
    hex: '00',
  });
  expect(() => db.saveUpload(job)).toThrow();
  expect(db.getLatestUpload(scope)?.items[0].state).toBe('pending');
  connection.exec('DROP TRIGGER reject_event');
  connection.close();
  db.saveUpload(job);
  expect(db.getLatestUpload(scope)?.items[0].state).toBe('in_flight');
  expect(db.getLatestUpload(scope)?.events).toHaveLength(1);
});

it('migrates complete legacy job JSON and recovers interrupted items', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scales-catalog-v1-'));
  directories.push(directory);
  const path = join(directory, 'catalog.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(
    'CREATE TABLE catalog_uploads(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,scope TEXT NOT NULL,device TEXT NOT NULL,value TEXT NOT NULL); PRAGMA user_version=1;',
  );
  const job = uploadJob('legacy', 'in_flight');
  job.events = [
    { at: '2026-10-11T01:00:01Z', phase: 'write', kind: 'tx', hex: '00' },
  ];
  legacy
    .prepare(
      'INSERT INTO catalog_uploads(id,scope,device,value) VALUES(?,?,?,?)',
    )
    .run(
      job.id,
      '["https://api.test/v1","user","member","org","store"]',
      '["192.168.1.8",5000]',
      JSON.stringify(job),
    );
  legacy.close();
  const { db } = open(path);
  expect(db.getLatestUpload(scope)).toMatchObject({
    status: 'interrupted',
    items: [{ state: 'uncertain', product }],
    events: job.events,
  });
  expect(
    db.uncertainProducts({ ...scope, userId: 'other' }, job.device),
  ).toEqual(new Set(['apple']));
});

it('serializes immutable packet records only once across repeated checkpoints', () => {
  const { db } = open();
  const job = uploadJob('immutable');
  job.items[0] = Object.freeze({
    ...job.items[0],
    product: Object.freeze({ ...product }),
  });
  job.events = [
    Object.freeze({
      at: '2026-10-11T01:00:00Z',
      phase: 'write',
      kind: 'tx',
      hex: '00',
    }),
  ];
  const item = job.items[0];
  const event = job.events[0];
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    db.saveUpload(job);
    db.saveUpload({
      ...job,
      items: job.items.slice(),
      events: job.events.slice(),
    });
    expect(
      stringify.mock.calls.filter(([value]) => value === item),
    ).toHaveLength(1);
    expect(
      stringify.mock.calls.filter(([value]) => value === event),
    ).toHaveLength(1);
    expect(db.getLatestUpload(scope)?.items[0]).toEqual(item);
  } finally {
    stringify.mockRestore();
  }
});

it('keeps detecting in-place product and event mutations from non-immutable callers', () => {
  const { db } = open();
  const job = uploadJob('mutable');
  job.items[0] = Object.freeze({ ...job.items[0], product: { ...product } });
  job.events = [
    { at: '2026-10-11T01:00:00Z', phase: 'write', kind: 'tx', hex: '00' },
  ];
  db.saveUpload(job);
  job.items[0].product.retail_price = '120.00';
  job.events[0].hex = '01';
  db.saveUpload(job);
  expect(db.getLatestUpload(scope)).toMatchObject({
    items: [{ product: { retail_price: '120.00' } }],
    events: [{ hex: '01' }],
  });
});

it('persists a confirmed clear without removing local products, settings or upload reports', () => {
  const { db, path } = open();
  complete(db);
  const upload = {
    ...uploadJob('before-clear', 'acknowledged'),
    status: 'completed' as const,
    finishedAt: '2026-10-11T01:01:00Z',
  };
  db.saveUpload(upload);
  db.saveDevice(scope, upload.device);
  const job = {
    ...clearJob('clear', 'acknowledged'),
    status: 'completed' as const,
    finishedAt: '2026-10-11T02:00:05Z',
    disconnectError: 'No disconnect ACK',
  };
  db.saveClear(job);
  db.close();
  databases.splice(databases.indexOf(db), 1);
  const reopened = open(path).db;
  expect(reopened.getLatestClear(scope)).toEqual(job);
  expect(reopened.uploadedProducts(scope, upload.device)).toEqual([]);
  expect(reopened.allProducts(scope)).toEqual([product]);
  expect(reopened.getDevice(scope)).toEqual(upload.device);
  expect(reopened.getLatestUpload(scope)).toEqual(upload);
  for (const field of [
    'apiUrl',
    'userId',
    'membershipId',
    'organizationId',
    'storeId',
  ] as const)
    expect(reopened.getLatestClear({ ...scope, [field]: 'other' })).toBeNull();
});

it.each([
  ['pending', 'pending'],
  ['in_flight', 'uncertain'],
  ['acknowledged', 'acknowledged'],
] as const)(
  'recovers an interrupted clear from %s as %s without resending it',
  (before, after) => {
    const { db, path } = open();
    const upload = uploadJob('before-restart', 'acknowledged');
    db.saveUpload(upload);
    const job = clearJob('interrupted-clear', before);
    db.saveClear(job);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = open(path).db;
    expect(reopened.getLatestClear(scope)).toMatchObject({
      status: 'interrupted',
      commandState: after,
      events: job.events,
      finishedAt: expect.any(String),
      error: expect.any(String),
    });
    expect(reopened.uploadedProducts(scope, upload.device)).toEqual(
      before === 'acknowledged' ? [] : [product],
    );
  },
);

it('resets the physical endpoint history across scopes while retaining other endpoints', () => {
  const { db } = open();
  const scopes = [
    scope,
    { ...scope, userId: 'other-user', membershipId: 'other-membership' },
    { ...scope, storeId: 'other-store' },
    { ...scope, organizationId: 'other-org' },
    { ...scope, apiUrl: 'https://other-api.test/v1' },
  ];
  scopes.forEach((entry, index) => {
    const upload = uploadJob(`scope-${index}`, 'uncertain');
    upload.scope = entry;
    db.saveUpload(upload);
  });
  const otherIp = uploadJob('other-ip', 'acknowledged');
  otherIp.device = { ...otherIp.device, scaleIp: '192.168.1.87' };
  const otherPort = uploadJob('other-port', 'uncertain');
  otherPort.device = { ...otherPort.device, port: 5001 };
  db.saveUpload(otherIp);
  db.saveUpload(otherPort);
  const job = clearJob('all-scopes', 'acknowledged');
  job.device.localAddress = '192.168.1.10';
  db.saveClear(job);
  for (const entry of scopes) {
    expect(db.uploadedProducts(entry, job.device)).toEqual([]);
    expect(db.uncertainProducts(entry, job.device)).toEqual(new Set());
  }
  expect(db.uploadedProducts(scope, otherIp.device)).toEqual([product]);
  expect(db.uncertainProducts(scope, otherPort.device)).toEqual(
    new Set(['apple']),
  );
});

it.each([false, true])(
  'does not advance a clear history cutoff on a later disconnect checkpoint (prior upload: %s)',
  (hasPriorUpload) => {
    const { db, path } = open();
    if (hasPriorUpload) db.saveUpload(uploadJob('old-upload', 'acknowledged'));
    const job = clearJob('one-clear', 'acknowledged');
    db.saveClear(job);
    const later = uploadJob('new-upload', 'uncertain');
    db.saveUpload(later);
    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = open(path).db;
    job.status = 'completed';
    job.disconnectError = 'Disconnect timed out';
    reopened.saveClear(job);
    expect(reopened.uploadedProducts(scope, job.device)).toEqual([product]);
    expect(reopened.uncertainProducts(scope, job.device)).toEqual(
      new Set(['apple']),
    );
    expect(reopened.getLatestClear(scope)?.disconnectError).toBe(
      'Disconnect timed out',
    );
  },
);

it.each(['pending', 'in_flight', 'rejected', 'uncertain'] as const)(
  'does not reset endpoint history for a %s clear',
  (commandState) => {
    const { db } = open();
    const upload = uploadJob('possible-content', 'uncertain');
    db.saveUpload(upload);
    db.saveClear({
      ...clearJob('unconfirmed-clear', commandState),
      status: 'failed',
    });
    expect(db.uploadedProducts(scope, upload.device)).toEqual([product]);
    expect(db.uncertainProducts(scope, upload.device)).toEqual(
      new Set(['apple']),
    );
  },
);

it('rejects reassignment of an existing clear job to another scope or endpoint', () => {
  const { db } = open();
  const job = clearJob('bound-target');
  db.saveClear(job);
  for (const field of [
    'apiUrl',
    'userId',
    'membershipId',
    'organizationId',
    'storeId',
  ] as const)
    expect(() =>
      db.saveClear({ ...job, scope: { ...scope, [field]: 'other' } }),
    ).toThrow();
  for (const device of [
    { ...job.device, scaleIp: '192.168.1.87' },
    { ...job.device, port: 5001 },
  ])
    expect(() => db.saveClear({ ...job, device })).toThrow();
  expect(db.getLatestClear(scope)).toEqual(job);
});

it('commits the clear ACK and endpoint history cutoff together', () => {
  const { db, path } = open();
  const upload = uploadJob('before-failed-save', 'acknowledged');
  db.saveUpload(upload);
  const job = clearJob('durable-clear', 'in_flight');
  db.saveClear(job);
  const connection = new DatabaseSync(path);
  connection.exec(
    "CREATE TRIGGER reject_clear_ack BEFORE UPDATE ON catalog_clears WHEN json_extract(NEW.value,'$.commandState')='acknowledged' BEGIN SELECT RAISE(ABORT,'cannot persist ACK'); END;",
  );
  job.commandState = 'acknowledged';
  expect(() => db.saveClear(job)).toThrow();
  expect(db.getLatestClear(scope)?.commandState).toBe('in_flight');
  expect(db.uploadedProducts(scope, upload.device)).toEqual([product]);
  connection.exec('DROP TRIGGER reject_clear_ack');
  connection.close();
  db.saveClear(job);
  expect(db.getLatestClear(scope)?.commandState).toBe('acknowledged');
  expect(db.uploadedProducts(scope, upload.device)).toEqual([]);
});

it('adds clear persistence to a version 2 database without rewriting its upload report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scales-catalog-v2-'));
  directories.push(directory);
  const path = join(directory, 'catalog.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE catalog_uploads(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,scope TEXT NOT NULL,device TEXT NOT NULL,device_scope TEXT NOT NULL,value TEXT NOT NULL);
    CREATE TABLE upload_items(job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(job_id,ordinal));
    CREATE TABLE upload_events(job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(job_id,ordinal));
    PRAGMA user_version=2;
  `);
  const upload = {
    ...uploadJob('v2-report', 'acknowledged'),
    status: 'completed' as const,
    finishedAt: '2026-10-11T01:01:00Z',
  };
  upload.events.push({
    at: upload.createdAt,
    phase: 'product:1',
    kind: 'rx',
    hex: '02',
  });
  const { items, events, ...header } = upload;
  legacy
    .prepare(
      'INSERT INTO catalog_uploads(id,scope,device,device_scope,value) VALUES(?,?,?,?,?)',
    )
    .run(
      upload.id,
      '["https://api.test/v1","user","member","org","store"]',
      '["192.168.1.8",5000]',
      '["https://api.test/v1","org","store"]',
      JSON.stringify(header),
    );
  legacy
    .prepare('INSERT INTO upload_items VALUES(?,?,?)')
    .run(upload.id, 0, JSON.stringify(items[0]));
  events.forEach((event, index) => {
    legacy
      .prepare('INSERT INTO upload_events VALUES(?,?,?)')
      .run(upload.id, index, JSON.stringify(event));
  });
  legacy.close();
  const { db } = open(path);
  expect(db.getLatestClear(scope)).toBeNull();
  db.saveClear(clearJob('migrated-clear', 'acknowledged'));
  expect(db.getLatestUpload(scope)).toEqual(upload);
  expect(db.uploadedProducts(scope, upload.device)).toEqual([]);
});
