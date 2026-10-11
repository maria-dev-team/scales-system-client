// @vitest-environment node
import { safeStorage } from 'electron';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { issueGrant } from './access';
import { CatalogGrantStore } from './grant-store';

const encryption = vi.hoisted(() => ({ available: true }));
vi.mock('electron', () => {
  const key = Buffer.alloc(32, 7);
  return {
    safeStorage: {
      isEncryptionAvailable: () => encryption.available,
      getSelectedStorageBackend: () => 'keychain',
      encryptString: (value: string): Buffer => {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const bytes = Buffer.concat([
          cipher.update(value, 'utf8'),
          cipher.final(),
        ]);
        return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
      },
      decryptString: (value: Buffer): string => {
        const cipher = createDecipheriv(
          'aes-256-gcm',
          key,
          value.subarray(0, 12),
        );
        cipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([
          cipher.update(value.subarray(28)),
          cipher.final(),
        ]).toString('utf8');
      },
    },
  };
});

const grant = issueGrant({
  apiUrl: 'https://api.example.test',
  userId: '00000000-0000-4000-8000-000000000001',
  membershipId: '00000000-0000-4000-8000-000000000002',
  organizationId: '00000000-0000-4000-8000-000000000003',
  storeId: '00000000-0000-4000-8000-000000000004',
  storeName: 'Confidential Store',
});
const directories: string[] = [];
async function setup(): Promise<{
  store: CatalogGrantStore;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'scales-grant-'));
  directories.push(directory);
  return { store: new CatalogGrantStore(directory), directory };
}
afterEach(async () => {
  encryption.available = true;
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('persists only encrypted verified fields and loads them after restart', async () => {
  const { store, directory } = await setup();
  expect(
    await store.save({
      ...grant,
      accessToken: 'never-persist',
    } as typeof grant),
  ).toBe(true);
  const bytes = await readFile(join(directory, 'access.enc'));
  expect(bytes.toString()).not.toContain('Confidential Store');
  expect(bytes.toString()).not.toContain('never-persist');
  expect(safeStorage.decryptString(bytes)).not.toContain('never-persist');
  expect(await new CatalogGrantStore(directory).load()).toEqual(grant);
  expect(await readdir(directory)).toEqual(['access.enc']);
});

it('serializes grant writes and logout so a delayed save cannot restore access', async () => {
  const { store } = await setup();
  await Promise.all([
    store.save(grant),
    store.save({ ...grant, lastSeenAt: grant.lastSeenAt + 1 }),
    store.save(null),
  ]);
  expect(await store.load()).toBeNull();
});

it('never falls back to plaintext when OS encryption is unavailable', async () => {
  const { store, directory } = await setup();
  await store.save(grant);
  encryption.available = false;
  expect(await store.save(grant)).toBe(false);
  expect(await readdir(directory)).toEqual([]);
  expect(await store.load()).toBeNull();
});

it('rejects a damaged grant without granting offline access', async () => {
  const { store, directory } = await setup();
  await writeFile(join(directory, 'access.enc'), 'broken');
  expect(await store.load()).toBeNull();
});
