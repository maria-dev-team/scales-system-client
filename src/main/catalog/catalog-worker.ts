import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import type { CatalogRequest } from '../../shared/catalog';
import type { CatalogGrant } from './access';
import { CatalogDatabase } from './database';
import { CatalogEngine } from './engine';

const port = parentPort!;
const config = workerData as {
  databasePath: string;
  apiUrl: string;
  grant: CatalogGrant | null;
};
mkdirSync(dirname(config.databasePath), { recursive: true });
const db = new CatalogDatabase(config.databasePath);
let grantId = 0;
const pendingGrants = new Map<
  number,
  { resolve: (saved: boolean) => void; reject: (error: Error) => void }
>();
let changedTimer: ReturnType<typeof setTimeout> | undefined;
let lastNotification = 0;
let lastUploading = false;
let closing = false;
function notifyChanged(): void {
  if (closing) return;
  const uploading = engine.isUploading();
  const now = Date.now();
  const send = (): void => {
    clearTimeout(changedTimer);
    changedTimer = undefined;
    lastNotification = Date.now();
    lastUploading = engine.isUploading();
    port.postMessage({ type: 'changed', uploading: lastUploading });
  };
  if (
    !uploading ||
    uploading !== lastUploading ||
    now - lastNotification >= 200
  )
    send();
  else changedTimer ??= setTimeout(send, 200 - (now - lastNotification));
}
const engine = new CatalogEngine(db, {
  apiUrl: config.apiUrl,
  grant: config.grant,
  changed: notifyChanged,
  refreshRequired: () => port.postMessage({ type: 'refresh-required' }),
  persistGrant: (grant) =>
    new Promise<boolean>((resolve, reject) => {
      const id = ++grantId;
      pendingGrants.set(id, { resolve, reject });
      port.postMessage({ type: 'persist-grant', id, grant });
    }),
});
const timer = setInterval(() => {
  void engine.tick();
}, 60_000);
timer.unref();
port.on(
  'message',
  (message: {
    type?: string;
    id: number;
    ok?: boolean;
    value?: boolean;
    message?: string;
    request?: CatalogRequest | { type: 'close' };
  }) => {
    if (message.type === 'grant-result') {
      const pending = pendingGrants.get(message.id);
      pendingGrants.delete(message.id);
      if (message.ok) pending?.resolve(message.value === true);
      else
        pending?.reject(
          new Error(
            message.message ?? 'Не удалось сохранить локальный доступ.',
          ),
        );
      return;
    }
    void (async () => {
      try {
        if (!message.request) throw new Error('Не передана команда.');
        let value: unknown;
        if (message.request.type === 'close') {
          closing = true;
          clearInterval(timer);
          clearTimeout(changedTimer);
          await engine.close();
          db.close();
        } else value = await engine.request(message.request);
        port.postMessage({ id: message.id, ok: true, value });
      } catch (error) {
        port.postMessage({
          id: message.id,
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : 'Не удалось выполнить операцию каталога.',
        });
      }
    })();
  },
);
port.postMessage({ type: 'ready' });
