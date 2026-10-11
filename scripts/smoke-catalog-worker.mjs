import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

// Exercise the same Node/SQLite runtime shipped to Windows users.
if (!process.versions.electron) {
  const require = createRequire(import.meta.url);
  const child = spawnSync(
    require('electron'),
    [fileURLToPath(import.meta.url)],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
    },
  );
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const directory = await mkdtemp(join(tmpdir(), 'scales-worker-smoke-'));
const scope = {
  apiUrl: 'https://example.invalid',
  userId: '00000000-0000-4000-8000-000000000001',
  membershipId: '00000000-0000-4000-8000-000000000002',
  organizationId: '00000000-0000-4000-8000-000000000003',
  storeId: '00000000-0000-4000-8000-000000000004',
  storeName: 'Offline smoke',
};
const now = Date.now();
const worker = new Worker(
  new URL('../out/main/catalog-worker.js', import.meta.url),
  {
    workerData: {
      databasePath: join(directory, 'catalog.sqlite'),
      apiUrl: scope.apiUrl,
      grant: {
        scope,
        verifiedAt: now,
        expiresAt: now + 8 * 3600_000,
        lastSeenAt: now,
      },
    },
  },
);
let sequence = 0;
const pending = new Map();
worker.on('message', (message) => {
  if (message.type === 'persist-grant') {
    worker.postMessage({
      type: 'grant-result',
      id: message.id,
      ok: true,
      value: true,
    });
  } else if (typeof message.id === 'number') {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) entry?.resolve(message.value);
    else entry?.reject(new Error(message.message));
  }
});
worker.on('error', (error) => {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
});
// Plain JavaScript entry point is also executed by Electron's bundled Node.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function request(value) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Worker response timed out'));
    }, 5000);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    worker.postMessage({ id, request: value });
  });
}
try {
  const state = await request({ type: 'state' });
  assert.equal(state.access, 'offline');
  assert.equal(state.scope.storeName, scope.storeName);
  assert.equal(state.total, 0);
  assert.deepEqual(await request({ type: 'list', search: '', offset: 0 }), {
    products: [],
    total: 0,
  });
  await request({ type: 'disconnect' });
  assert.equal((await request({ type: 'state' })).scope, null);
  await request({ type: 'close' });
  console.log(
    `Catalog worker smoke passed (Electron ${process.versions.electron}, Node ${process.versions.node}, SQLite offline access).`,
  );
} finally {
  await worker.terminate();
  await rm(directory, { recursive: true, force: true });
}
