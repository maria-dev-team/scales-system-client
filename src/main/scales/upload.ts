import { type Socket, createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';

import type { UploadEvent, UploadItem, UploadJob } from '../../shared/catalog';
import {
  encodeCapabilitiesRequest,
  encodeConnect,
  encodeDisconnect,
  parseCapabilities,
} from '../diagnostics/transfer-codec';
import { encodeCatalogProduct } from './codec';

type UploadOptions = { timeoutMs?: number; createSocket?: () => Socket };

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function runUpload(
  input: UploadJob,
  signal: AbortSignal,
  persist: (snapshot: UploadJob) => Promise<void>,
  options: UploadOptions = {},
): Promise<UploadJob> {
  const job = structuredClone(input);
  Object.freeze(job.scope);
  Object.freeze(job.device);
  for (const entry of job.items) {
    Object.freeze(entry.product);
    Object.freeze(entry);
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  let socket: Socket | null = null;
  let socketError: Error | null = null;
  let persistenceError: unknown;
  let persistenceFailed = false;
  let rejectPending: ((error: Error) => void) | null = null;
  let receive: ((packet: Buffer) => void) | null = null;
  let sessionSent = false;
  let item: UploadItem | null = null;
  let itemIndex = -1;
  let itemSent = false;

  function event(value: Omit<UploadEvent, 'at'>): void {
    job.events.push(Object.freeze({ ...value, at: new Date().toISOString() }));
  }

  function updateItem(
    change: Partial<Pick<UploadItem, 'state' | 'error'>>,
  ): void {
    item = Object.freeze({ ...item!, ...change });
    job.items[itemIndex] = item;
  }

  async function save(): Promise<void> {
    try {
      // Changed item records are replaced, and payload/profile data is frozen.
      // Reference-array copies preserve prior snapshots without copying every
      // product and packet again at each durable write.
      await persist({
        ...job,
        items: job.items.slice(),
        events: job.events.slice(),
      });
    } catch (error) {
      persistenceFailed = true;
      persistenceError = error;
      throw error;
    }
  }

  function checkActive(ignoreAbort: boolean): void {
    if (!ignoreAbort && signal.aborted) throw cancellationError();
    if (socketError) throw socketError;
  }

  function abort(): void {
    rejectPending?.(cancellationError());
  }

  function cancellationError(): Error {
    return signal.reason instanceof Error && signal.reason.name !== 'AbortError'
      ? signal.reason
      : new Error('Загрузка отменена');
  }

  async function exchange(
    packet: Buffer,
    phase: string,
    ignoreAbort = false,
  ): Promise<Buffer> {
    checkActive(ignoreAbort);
    event({
      phase: `${phase}:planned`,
      kind: 'tx',
      hex: packet.toString('hex'),
    });
    await save();
    checkActive(ignoreAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<Buffer>((resolve, reject) => {
      receive = resolve;
      rejectPending = reject;
      timer = setTimeout(
        () => reject(new Error(`Нет ответа весов (${phase})`)),
        timeoutMs,
      );
      if (phase === 'connect') sessionSent = true;
      if (item && phase.startsWith('product:')) itemSent = true;
      try {
        socket!.send(packet, job.device.port, job.device.scaleIp, (error) => {
          if (error) reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
    try {
      const received = await response;
      event({
        phase,
        kind: 'rx',
        // UDP already bounds a datagram; an unexpected response stops the job.
        // Preserve it in full so the exported evidence is not silently cut.
        hex: received.toString('hex'),
      });
      await save();
      return received;
    } finally {
      if (timer) clearTimeout(timer);
      receive = null;
      rejectPending = null;
    }
  }

  function ack(packet: Buffer): void {
    if (packet.length === 1 && packet[0] === 2) return;
    if (packet.length === 1 && packet[0] === 0x55) {
      if (item) updateItem({ state: 'rejected' });
      throw new Error('Весы отклонили команду (55)');
    }
    throw new Error('Неизвестный ответ весов; результат записи не подтверждён');
  }

  try {
    const { scaleIp, localAddress, port } = job.device;
    if (
      !isIPv4(scaleIp) ||
      !isIPv4(localAddress) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new Error(
        'Требуются IPv4-адрес весов, локальный IPv4-адрес и порт 1–65535',
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error('Недопустимый таймаут');
    // One TX/RX pair per exchange: the item limit bounds the complete evidence
    // without deleting early acknowledgements from a successful bulk upload.
    if (job.items.length > 10000)
      throw new Error('Одно задание может содержать не более 10000 товаров');
    if (
      !job.items.length ||
      job.status !== 'running' ||
      job.items.some((entry) => entry.state !== 'pending')
    ) {
      throw new Error(
        'Загрузка требует нового задания с неотправленными товарами',
      );
    }
    const plus = new Set<number | null>();
    for (const entry of job.items) {
      if (
        entry.product.organization_id !== job.scope.organizationId ||
        entry.product.store_id !== job.scope.storeId
      ) {
        throw new Error('Товар относится к другой организации или магазину');
      }
      if (plus.has(entry.product.scale_plu))
        throw new Error('В задании повторяется PLU');
      plus.add(entry.product.scale_plu);
      if (
        encodeCatalogProduct(entry.product, job.device).toString('hex') !==
        entry.packetHex
      ) {
        throw new Error(
          'Сохранённый пакет не соответствует товару и настройкам весов',
        );
      }
    }
    checkActive(false);
    socket = options.createSocket?.() ?? createSocket('udp4');
    socket.on('error', (error) => {
      socketError = error;
      rejectPending?.(error);
    });
    socket.on('message', (packet, peer) => {
      if (peer.address === scaleIp && peer.port === port)
        receive?.(Buffer.from(packet));
    });
    signal.addEventListener('abort', abort);
    await new Promise<void>((resolve, reject) => {
      const bound = (): void => {
        socket!.off('error', failed);
        resolve();
      };
      const failed = (error: Error): void => {
        socket!.off('listening', bound);
        reject(error);
      };
      socket!.once('error', failed);
      socket!.once('listening', bound);
      socket!.bind({ address: localAddress, port: 0, exclusive: true });
    });
    ack(await exchange(encodeConnect(scaleIp, new Date()), 'connect'));
    const capabilities = await exchange(
      encodeCapabilitiesRequest(),
      'capabilities',
    );
    if (!capabilities.subarray(0, 3).equals(Buffer.from([0x0e, 3, 0]))) {
      throw new Error('Неизвестный заголовок возможностей весов');
    }
    parseCapabilities(capabilities);
    for (const [index, next] of job.items.entries()) {
      checkActive(false);
      itemIndex = index;
      item = next;
      itemSent = false;
      updateItem({ state: 'in_flight' });
      ack(
        await exchange(
          Buffer.from(item.packetHex, 'hex'),
          `product:${item.product.scale_plu}`,
        ),
      );
      updateItem({ state: 'acknowledged', error: null });
      await save();
      item = null;
    }
    job.status = 'completed';
  } catch (error) {
    if (
      item &&
      (item.state === 'in_flight' || (persistenceFailed && itemSent))
    ) {
      updateItem({ state: itemSent ? 'uncertain' : 'pending' });
    }
    if (item && item.state !== 'pending') updateItem({ error: message(error) });
    job.error = message(error);
    job.status = signal.aborted ? 'cancelled' : 'failed';
    event({ kind: 'error', phase: 'upload', message: job.error });
  } finally {
    signal.removeEventListener('abort', abort);
    if (sessionSent && !persistenceFailed) {
      item = null;
      try {
        ack(
          await exchange(
            encodeDisconnect(job.device.scaleIp),
            'disconnect',
            true,
          ),
        );
      } catch (error) {
        job.disconnectError = message(error);
        event({
          kind: 'error',
          phase: 'disconnect',
          message: job.disconnectError,
        });
      }
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        /* A failed bind may leave no open socket. */
      }
    }
  }
  if (persistenceFailed) throw persistenceError;
  job.finishedAt = new Date().toISOString();
  await save();
  return job;
}
