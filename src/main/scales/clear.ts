import { type Socket, createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';

import type { ClearPluJob, UploadEvent } from '../../shared/catalog';
import {
  encodeCapabilitiesRequest,
  encodeConnect,
  encodeDisconnect,
  parseCapabilities,
} from '../diagnostics/transfer-codec';

type ClearOptions = {
  timeoutMs?: number;
  clearTimeoutMs?: number;
  createSocket?: () => Socket;
};

export function encodeClearPluPackets(): Buffer[] {
  // RLS1000 v1.129: 79C687 / 79C6AD -> 7A2448 -> 6D4604.
  // Fixed ROM PLU ranges only. The next vendor range contains messages and
  // deliberately is not part of this command; no arbitrary address is accepted.
  return [
    [0x0400, 0x07ff],
    [0x0200, 0x02ff],
  ].map(([start, end]) => {
    const packet = Buffer.alloc(261);
    packet.set([0x0e, 4, 0]);
    packet.writeUInt16LE(start, 3);
    packet.writeUInt16LE(end, 5);
    packet.writeUInt16LE(
      packet.subarray(0, 259).reduce((sum, byte) => sum + byte, 0) & 0xffff,
      259,
    );
    return packet;
  });
}

class RejectedAck extends Error {}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function ack(packet: Buffer): void {
  if (packet.length === 1 && packet[0] === 2) return;
  if (packet.length === 1 && packet[0] === 0x55)
    throw new RejectedAck('Весы отклонили команду (55)');
  throw new Error('Неизвестный ответ весов; результат команды не подтверждён');
}

export async function runClearPlu(
  input: ClearPluJob,
  signal: AbortSignal,
  persist: (snapshot: ClearPluJob) => Promise<void>,
  options: ClearOptions = {},
): Promise<ClearPluJob> {
  const job = structuredClone(input);
  const timeoutMs = options.timeoutMs ?? 5000;
  // Vendor DownloadPLU multiplies its current base timeout by 30 (79C649).
  // Erasing ROM can be much slower than the ordinary session exchanges.
  const clearTimeoutMs = options.clearTimeoutMs ?? 60000;
  let socket: Socket | null = null;
  let socketError: Error | null = null;
  let persistenceFailed = false;
  let persistenceError: unknown;
  let rejectPending: ((error: Error) => void) | null = null;
  let receive: ((packet: Buffer) => void) | null = null;
  let sessionSent = false;
  let clearSent = false;
  let acknowledgedRanges = 0;

  function event(value: Omit<UploadEvent, 'at'>): void {
    job.events.push({ ...value, at: new Date().toISOString() });
  }

  async function save(): Promise<void> {
    try {
      // A durable snapshot must never change underneath an asynchronous writer.
      await persist(structuredClone(job));
    } catch (error) {
      persistenceFailed = true;
      persistenceError = error;
      throw error;
    }
  }

  function checkActive(ignoreAbort = false): void {
    if (!ignoreAbort && signal.aborted) throw new Error('Очистка отменена');
    if (socketError) throw socketError;
  }

  function abort(): void {
    rejectPending?.(new Error('Очистка отменена'));
  }

  async function bind(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = (): void => finishBind?.();
    let finishBind: (() => void) | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        finishBind = resolve;
        rejectPending = reject;
        timer = setTimeout(
          () =>
            reject(new Error('Не удалось открыть локальный UDP-сокет вовремя')),
          timeoutMs,
        );
        socket!.once('listening', bound);
        checkActive();
        socket!.bind({
          address: job.device.localAddress,
          port: 0,
          exclusive: true,
        });
      });
    } finally {
      if (timer) clearTimeout(timer);
      socket!.off('listening', bound);
      rejectPending = null;
    }
  }

  async function exchange(
    packet: Buffer,
    phase: string,
    ignoreAbort = false,
  ): Promise<Buffer> {
    checkActive(ignoreAbort);
    event({
      kind: 'tx',
      phase: `${phase}:planned`,
      hex: packet.toString('hex'),
    });
    await save();
    checkActive(ignoreAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const received = await new Promise<Buffer>((resolve, reject) => {
        receive = (response) => {
          receive = null;
          resolve(response);
        };
        rejectPending = reject;
        timer = setTimeout(
          () => reject(new Error(`Нет ответа весов (${phase})`)),
          phase.startsWith('clear:') ? clearTimeoutMs : timeoutMs,
        );
        if (phase === 'connect') sessionSent = true;
        // A send error does not prove that the device did not execute the erase.
        if (phase.startsWith('clear:')) clearSent = true;
        try {
          socket!.send(packet, job.device.port, job.device.scaleIp, (error) => {
            if (error) reject(error);
          });
        } catch (error) {
          reject(error);
        }
      });
      event({ kind: 'rx', phase, hex: received.toString('hex') });
      await save();
      return received;
    } finally {
      if (timer) clearTimeout(timer);
      receive = null;
      rejectPending = null;
    }
  }

  try {
    const { scaleIp, localAddress, port } = job.device;
    if (
      !isIPv4(scaleIp) ||
      !isIPv4(localAddress) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error(
        'Требуются IPv4-адрес весов, локальный IPv4-адрес и порт 1–65535',
      );
    if (
      ![timeoutMs, clearTimeoutMs].every(
        (value) => Number.isFinite(value) && value > 0 && value <= 2147483647,
      )
    )
      throw new Error('Недопустимый таймаут');
    if (
      !job.id ||
      job.status !== 'running' ||
      job.commandState !== 'pending' ||
      job.events.length !== 0 ||
      job.finishedAt !== null ||
      job.error !== null ||
      job.disconnectError !== null
    )
      throw new Error('Очистка требует нового задания без отправленных команд');
    checkActive();
    socket = options.createSocket?.() ?? createSocket('udp4');
    socket.on('error', (error: Error) => {
      socketError = error;
      rejectPending?.(error);
    });
    socket.on('message', (packet, peer) => {
      if (peer.address === scaleIp && peer.port === port)
        receive?.(Buffer.from(packet));
    });
    signal.addEventListener('abort', abort);
    await bind();
    ack(await exchange(encodeConnect(scaleIp, new Date()), 'connect'));
    const capabilities = await exchange(
      encodeCapabilitiesRequest(),
      'capabilities',
    );
    if (!capabilities.subarray(0, 3).equals(Buffer.from([0x0e, 3, 0])))
      throw new Error('Неизвестный заголовок возможностей весов');
    const profile = parseCapabilities(capabilities);
    if (
      profile.fingerprint !== 'LB1.00' ||
      profile.family !== 'LS' ||
      profile.nameBytes !== 36
    )
      throw new Error(
        'Очистка поддерживается только для профиля LB1.00 / LS с именем PLU 36 байт',
      );
    const packets = encodeClearPluPackets();
    for (const [index, range] of ['extended', 'base'].entries()) {
      checkActive();
      job.commandState = 'in_flight';
      const response = await exchange(packets[index], `clear:${range}`);
      checkActive();
      ack(response);
      acknowledgedRanges++;
    }
    job.commandState = 'acknowledged';
    job.status = 'completed';
    await save();
  } catch (error) {
    job.commandState = !clearSent
      ? 'pending'
      : error instanceof RejectedAck &&
          acknowledgedRanges === 0 &&
          !signal.aborted
        ? 'rejected'
        : 'uncertain';
    job.status = signal.aborted ? 'cancelled' : 'failed';
    job.error = message(error);
    event({ kind: 'error', phase: 'clear', message: job.error });
  } finally {
    signal.removeEventListener('abort', abort);
    // Once recording fails, even cleanup packets must stop. The last durable
    // in-flight intent remains the recovery evidence; never retry an erase.
    if (sessionSent && !persistenceFailed) {
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
        /* Failed bind may leave no open socket. */
      }
    }
  }
  if (persistenceFailed) throw persistenceError;
  job.finishedAt = new Date().toISOString();
  await save();
  return job;
}
