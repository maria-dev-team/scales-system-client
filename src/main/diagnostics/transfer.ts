import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';

import type {
  CheckResult,
  DiagnosticProfile,
  TransferTestOptions,
} from '../../shared/diagnostics';
import {
  encodeCapabilitiesRequest,
  encodeConnect,
  encodeDisconnect,
  encodeTestProduct,
  parseCapabilities,
} from './transfer-codec';

interface WireEvent {
  at: string;
  phase: string;
  kind: 'tx-planned' | 'tx-sent' | 'rx' | 'rx-ignored' | 'error';
  address?: string;
  port?: number;
  bytes?: number;
  hex?: string;
  truncated?: boolean;
  error?: string;
}

// One explicit experiment, no automatic retries: a lost ACK can follow a successful write.
export async function transferTestProduct(
  profile: DiagnosticProfile,
  options: TransferTestOptions,
  signal: AbortSignal,
  onProgress: (result: CheckResult) => Promise<void>,
): Promise<CheckResult> {
  if (
    !isIPv4(profile.scaleIp) ||
    !isIPv4(profile.localAddress) ||
    !Number.isInteger(profile.port) ||
    profile.port < 1 ||
    profile.port > 65535
  )
    throw new Error('Неверный профиль передачи.');
  const product = encodeTestProduct(options.priceDecimals);
  const events: WireEvent[] = [];
  let phase = 'prepare';
  let writeOutcome: 'not-sent' | 'uncertain' | 'rejected' | 'acknowledged' =
    'not-sent';
  let sessionOpened = false;
  let sessionClosed = false;
  let disconnectAttempted = false;
  let completed = false;
  let persistenceFailed = false;
  let timedOut = false;
  let failure: string | undefined;
  let cleanupError: string | undefined;
  let ignoredReplies = 0;
  let localPort: number | undefined;
  let capabilities: ReturnType<typeof parseCapabilities> | undefined;
  let socketError: Error | null = null;
  let pending: {
    resolve: (bytes: Buffer) => void;
    reject: (error: Error) => void;
  } | null = null;

  const snapshot = (): CheckResult => ({
    status: signal.aborted
      ? 'cancelled'
      : completed
        ? 'passed'
        : writeOutcome === 'acknowledged'
          ? 'warning'
          : 'failed',
    summary: completed
      ? 'Весы подтвердили пакеты тестового сеанса. Проверьте TEST APPLE и напечатайте этикетку на весах.'
      : `${signal.aborted ? 'Передача остановлена.' : (failure ?? `Этап передачи: ${phase}.`)}${
          writeOutcome === 'uncertain'
            ? ' Товар мог быть записан: ответ не подтверждён. Автоповтора нет; проверьте товар на весах.'
            : writeOutcome === 'acknowledged'
              ? ' Ответ на запись получен, завершение сеанса ещё не подтверждено.'
              : ''
        }`,
    details: {
      driver: 'RLS1000 v1.129 update experiment',
      target: profile,
      localPort,
      priceDecimals: options.priceDecimals,
      writeOutcome,
      sessionOpened,
      sessionClosed,
      timedOut,
      cancelled: signal.aborted,
      protocolVerified: false,
      printVerified: false,
      readbackPerformed: false,
      capabilities,
      error: failure,
      cleanupError,
      ignoredReplies,
      events: structuredClone(events),
    },
  });
  const persist = async (): Promise<void> => {
    try {
      await onProgress(snapshot());
    } catch (error) {
      persistenceFailed = true;
      throw error;
    }
  };
  const checkActive = (): void => {
    if (signal.aborted) throw new Error('Передача отменена.');
    if (socketError) throw socketError;
  };
  const event = (entry: Omit<WireEvent, 'at' | 'phase'>): void => {
    // Bound unsolicited traffic while retaining room for all four command exchanges.
    if (entry.kind === 'rx-ignored' && ignoredReplies > 16) return;
    events.push({ at: new Date().toISOString(), phase, ...entry });
  };

  await persist();
  if (signal.aborted) return snapshot();
  const socket = createSocket('udp4');
  socket.on('error', (error) => {
    socketError = error;
    pending?.reject(error);
  });
  socket.on('message', (bytes, peer) => {
    const accepted =
      peer.address === profile.scaleIp &&
      peer.port === profile.port &&
      pending !== null;
    if (!accepted) ignoredReplies++;
    event({
      kind: accepted ? 'rx' : 'rx-ignored',
      address: peer.address,
      port: peer.port,
      bytes: bytes.length,
      hex: bytes.subarray(0, 512).toString('hex'),
      ...(bytes.length > 512 ? { truncated: true } : {}),
    });
    if (accepted) {
      const waiting = pending!;
      pending = null;
      waiting.resolve(Buffer.from(bytes));
    }
  });
  const abort = (): void => {
    pending?.reject(new Error('Передача отменена.'));
  };
  signal.addEventListener('abort', abort, { once: true });

  const exchange = async (
    nextPhase: string,
    packet: Buffer,
  ): Promise<Buffer> => {
    phase = nextPhase;
    checkActive();
    event({
      kind: 'tx-planned',
      address: profile.scaleIp,
      port: profile.port,
      bytes: packet.length,
      hex: packet.toString('hex'),
    });
    await persist(); // Never hand bytes to the OS before the report snapshot has been saved.
    checkActive();
    let timer: ReturnType<typeof setTimeout>;
    const response = new Promise<Buffer>((resolve, reject) => {
      pending = {
        resolve: (bytes) => {
          clearTimeout(timer);
          resolve(bytes);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Таймаут ответа весов: ${nextPhase} (2000 мс).`));
      }, 2000);
    });
    // Errors/cancellation can arrive while the send callback or disk write is pending.
    void response.catch(() => {});
    try {
      if (nextPhase === 'write') writeOutcome = 'uncertain';
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          socket.send(packet, profile.port, profile.scaleIp, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
        response.then(() => undefined),
      ]);
      event({
        kind: 'tx-sent',
        address: profile.scaleIp,
        port: profile.port,
        bytes: packet.length,
        hex: packet.toString('hex'),
      });
      await persist();
      const bytes = await response;
      await persist();
      checkActive();
      return bytes;
    } finally {
      clearTimeout(timer!);
      pending = null;
    }
  };
  const requireAck = (reply: Buffer): void => {
    if (reply.length === 1 && reply[0] === 0x02) return;
    if (reply.length === 1 && reply[0] === 0x55) {
      if (phase === 'write') writeOutcome = 'rejected';
      throw new Error(`Весы отклонили команду: ${phase} (55).`);
    }
    throw new Error(
      `Неизвестный ответ на ${phase}; ожидается однобайтовый ACK 02.`,
    );
  };
  const disconnect = async (): Promise<void> => {
    disconnectAttempted = true;
    requireAck(await exchange('disconnect', encodeDisconnect(profile.scaleIp)));
    sessionClosed = true;
  };

  try {
    checkActive();
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        socket.removeListener('error', failed);
        if (error) reject(error);
        else resolve();
      };
      const stop = (): void => done(new Error('Передача отменена.'));
      const failed = (error: Error): void => done(error);
      const timer = setTimeout(() => {
        timedOut = true;
        done(new Error('Таймаут открытия UDP-сокета.'));
      }, 2000);
      signal.addEventListener('abort', stop, { once: true });
      socket.once('error', failed);
      socket.bind(
        { address: profile.localAddress, port: 0, exclusive: true },
        () => done(),
      );
      if (signal.aborted) stop();
    });
    localPort = socket.address().port;
    requireAck(
      await exchange('connect', encodeConnect(profile.scaleIp, new Date())),
    );
    sessionOpened = true;
    capabilities = parseCapabilities(
      await exchange('capabilities', encodeCapabilitiesRequest()),
    );
    requireAck(await exchange('write', product));
    writeOutcome = 'acknowledged';
    await disconnect();
    completed = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    event({ kind: 'error', error: failure });
    if (
      sessionOpened &&
      !disconnectAttempted &&
      !signal.aborted &&
      !persistenceFailed
    ) {
      try {
        await disconnect();
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
        event({ kind: 'error', error: cleanupError });
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    pending = null;
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  await persist();
  return snapshot();
}
