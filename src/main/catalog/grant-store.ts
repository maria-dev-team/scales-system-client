import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { type CatalogGrant, grantSchema } from './access';

export class CatalogGrantStore {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(private readonly directory: string) {
    this.path = join(directory, 'access.enc');
  }
  private available(): boolean {
    return (
      safeStorage.isEncryptionAvailable() &&
      !(
        process.platform === 'linux' &&
        safeStorage.getSelectedStorageBackend() === 'basic_text'
      )
    );
  }
  async load(): Promise<CatalogGrant | null> {
    await this.pending;
    if (!this.available()) return null;
    let bytes: Buffer;
    try {
      if ((await stat(this.path)).size > 65_536) return null;
      bytes = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const parsed = grantSchema.safeParse(
        JSON.parse(safeStorage.decryptString(bytes)),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  save(grant: CatalogGrant | null): Promise<boolean> {
    // Validate and copy before queuing so a later tick cannot alter this write.
    const value = grant === null ? null : grantSchema.parse(grant);
    const job = this.pending.then(() => this.write(value));
    this.pending = job.catch(() => undefined);
    return job;
  }
  private async write(grant: CatalogGrant | null): Promise<boolean> {
    if (grant === null || !this.available()) {
      await rm(this.path, { force: true });
      return grant === null;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `access-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(safeStorage.encryptString(JSON.stringify(grant)));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      return true;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
