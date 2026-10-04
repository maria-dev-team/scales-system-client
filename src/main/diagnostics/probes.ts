import { randomBytes } from 'node:crypto';
import { type Socket, createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { win32 } from 'node:path';

import type {
  CheckResult,
  CommandResult,
  DiagnosticProfile,
  NetworkAdapter,
} from '../../shared/diagnostics';
import { runCommand } from './command';

export { checkPluFixture } from './plu';

function ipv4Number(address: string): number {
  return address
    .split('.')
    .reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

function isUnicast(address: unknown): address is string {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const first = Number(address.split('.')[0]);
  return first !== 0 && first !== 127 && first < 224;
}

export function getNetworkAdapters(): NetworkAdapter[] {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter(
        (entry) =>
          entry.family === 'IPv4' &&
          !entry.internal &&
          isUnicast(entry.address),
      )
      .map(({ address, netmask, mac }) => ({ name, address, netmask, mac })),
  );
}

export function parseProfile(input: unknown): DiagnosticProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Требуются параметры подключения.');
  const value = input as Record<string, unknown>;
  if (!isUnicast(value.scaleIp))
    throw new Error('Укажите корректный IPv4-адрес весов (unicast).');
  if (
    typeof value.port !== 'number' ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  )
    throw new Error('Порт должен быть целым числом от 1 до 65535.');
  if (!isUnicast(value.localAddress))
    throw new Error('Укажите корректный IPv4-адрес локального адаптера.');
  if (value.scaleIp === value.localAddress)
    throw new Error('Адрес весов совпадает с адресом компьютера.');
  return {
    scaleIp: value.scaleIp,
    port: value.port,
    localAddress: value.localAddress,
  };
}

export function validateProfile(
  input: unknown,
  adapters: NetworkAdapter[],
): DiagnosticProfile {
  const value = parseProfile(input);
  const adapter = adapters.find((item) => item.address === value.localAddress);
  if (!adapter)
    throw new Error(
      'Выбранный сетевой адаптер недоступен. Выберите его заново.',
    );
  if (adapters.some((item) => item.address === value.scaleIp))
    throw new Error('Адрес весов совпадает с адресом компьютера.');
  const target = ipv4Number(value.scaleIp);
  const mask = ipv4Number(adapter.netmask);
  const network = (ipv4Number(adapter.address) & mask) >>> 0;
  const broadcast = (network | ~mask) >>> 0;
  if (mask < 0xfffffffe && (target === network || target === broadcast))
    throw new Error('Адрес сети или broadcast не может быть адресом весов.');
  return {
    scaleIp: value.scaleIp,
    port: value.port,
    localAddress: adapter.address,
  };
}

export function checkSubnet(
  profile: DiagnosticProfile,
  adapters: NetworkAdapter[],
): CheckResult {
  const adapter = adapters.find(
    (item) => item.address === profile.localAddress,
  );
  if (!adapter)
    return {
      status: 'failed',
      summary:
        'Выбранный адаптер недоступен. Подключите кабель и выберите адаптер заново.',
    };
  const mask = ipv4Number(adapter.netmask);
  const sameSubnet =
    (ipv4Number(profile.scaleIp) & mask) ===
    (ipv4Number(adapter.address) & mask);
  return {
    status: sameSubnet ? 'passed' : 'warning',
    summary: sameSubnet
      ? 'IP весов и выбранный адаптер находятся в одной подсети.'
      : 'IP весов и адаптер в разных подсетях. Для прямого кабеля проверьте IPv4 и маску ПК.',
    details: {
      adapter,
      scaleIp: profile.scaleIp,
      sameSubnet,
      note: 'Ping uses the OS routing table; the selected adapter is only used for the UDP bind check.',
    },
  };
}

function windowsExecutable(name: string): string {
  return win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);
}

function powershell(): string {
  return windowsExecutable('WindowsPowerShell\\v1.0\\powershell.exe');
}

async function windowsEncoding(
  signal: AbortSignal,
): Promise<{ encoding: string; command: CommandResult }> {
  const script =
    'Add-Type -Namespace ScalesDiagnostics -Name Native -MemberDefinition \'[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetOEMCP();\'; [ScalesDiagnostics.Native]::GetOEMCP()';
  const command = await runCommand(
    powershell(),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    signal,
  );
  const codePage = command.stdout.trim();
  const known: Record<string, string> = {
    '65001': 'utf-8',
    '866': 'ibm866',
    '1251': 'windows-1251',
    '1252': 'windows-1252',
    '936': 'gbk',
    '932': 'shift_jis',
    '949': 'euc-kr',
    '950': 'big5',
  };
  return {
    command,
    encoding: known[codePage] ?? `OEM ${codePage || 'unknown'}`,
  };
}

function commandFailed(command: CommandResult): boolean {
  return (
    command.exitCode !== 0 ||
    !!command.error ||
    command.timedOut ||
    command.cancelled ||
    !!command.truncated
  );
}

function commandCheck(commands: CommandResult[], summary: string): CheckResult {
  return {
    status: commands.some((item) => item.cancelled)
      ? 'cancelled'
      : commands.some(commandFailed)
        ? 'warning'
        : 'passed',
    summary: commands.some((item) => item.cancelled)
      ? 'Проверка остановлена.'
      : commands.some(commandFailed)
        ? `${summary}: часть команд не завершилась успешно; см. вывод.`
        : `${summary}: вывод сохранён.`,
    commands,
  };
}

async function nativeCommands(
  platform: NodeJS.Platform,
  commands: string[][],
  signal: AbortSignal,
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  let encoding = 'utf-8';
  if (platform === 'win32') {
    const detected = await windowsEncoding(signal);
    results.push(detected.command);
    encoding = detected.encoding;
  }
  for (const [executable, ...args] of commands) {
    if (signal.aborted) break;
    results.push(await runCommand(executable, args, signal, { encoding }));
  }
  return results;
}

export async function runNetworkCommands(
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<CheckResult> {
  if (signal.aborted)
    return { status: 'cancelled', summary: 'Проверка остановлена.' };
  const commands =
    platform === 'win32'
      ? [
          [windowsExecutable('ipconfig.exe'), '/all'],
          [windowsExecutable('route.exe'), 'print', '-4'],
        ]
      : platform === 'darwin'
        ? [['/sbin/ifconfig'], ['/usr/sbin/netstat', '-rn', '-f', 'inet']]
        : null;
  if (!commands)
    return {
      status: 'skipped',
      summary: 'Системные команды предусмотрены для Windows и macOS.',
    };
  return commandCheck(
    await nativeCommands(platform, commands, signal),
    'Конфигурация сети',
  );
}

export async function runArp(
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<CheckResult> {
  if (signal.aborted)
    return { status: 'cancelled', summary: 'Проверка остановлена.' };
  if (platform !== 'win32' && platform !== 'darwin')
    return {
      status: 'skipped',
      summary: 'ARP предусмотрен для Windows и macOS.',
    };
  return commandCheck(
    await nativeCommands(
      platform,
      [
        [
          platform === 'win32' ? windowsExecutable('arp.exe') : '/usr/sbin/arp',
          platform === 'win32' ? '-a' : '-an',
        ],
      ],
      signal,
    ),
    'Таблица ARP',
  );
}

export async function checkReachability(
  profile: DiagnosticProfile,
  platform: NodeJS.Platform,
  signal: AbortSignal,
): Promise<CheckResult> {
  if (signal.aborted)
    return { status: 'cancelled', summary: 'Проверка остановлена.' };
  if (!isUnicast(profile.scaleIp))
    return { status: 'failed', summary: 'Некорректный IP весов.' };
  if (platform !== 'win32' && platform !== 'darwin')
    return {
      status: 'skipped',
      summary: 'ICMP-проверка предусмотрена для Windows и macOS.',
    };
  const commands = await nativeCommands(
    platform,
    [
      platform === 'win32'
        ? [
            windowsExecutable('ping.exe'),
            '-n',
            '2',
            '-w',
            '1000',
            profile.scaleIp,
          ]
        : ['/sbin/ping', '-n', '-c', '2', '-W', '1000', profile.scaleIp],
    ],
    signal,
  );
  let reply: unknown;
  let success = false;
  if (platform === 'win32' && !signal.aborted) {
    // The IP was strictly validated above; no user-controlled command or script is accepted.
    const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference = 'Stop'; $p = New-Object System.Net.NetworkInformation.Ping; try { $r = $p.Send('${profile.scaleIp}', 1000); [PSCustomObject]@{ Status = $r.Status.ToString(); Address = if ($r.Address) { $r.Address.ToString() } else { $null }; RoundtripTime = $r.RoundtripTime } | ConvertTo-Json -Compress } catch { [PSCustomObject]@{ Status = 'Error'; Error = $_.Exception.Message } | ConvertTo-Json -Compress; exit 1 } finally { $p.Dispose() }`;
    const confirmation = await runCommand(
      powershell(),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      signal,
      { encoding: 'utf-8' },
    );
    commands.push(confirmation);
    try {
      reply = JSON.parse(confirmation.stdout.replace(/^\uFEFF/, '').trim());
      success =
        !commandFailed(confirmation) &&
        typeof reply === 'object' &&
        reply !== null &&
        (reply as { Status?: string }).Status === 'Success' &&
        (reply as { Address?: string }).Address === profile.scaleIp;
    } catch {
      reply = {
        error: 'No valid .NET Ping JSON result; inspect command output.',
      };
    }
  } else if (platform === 'darwin') {
    const ping = commands[0];
    // Successful process exit alone is not proof of a target echo reply.
    success =
      !!ping &&
      !commandFailed(ping) &&
      ping.stdout
        .split('\n')
        .some(
          (line) =>
            line.includes(`bytes from ${profile.scaleIp}:`) &&
            /icmp_seq=\d+.*\bttl=\d+.*\btime[=<]/i.test(line),
        );
  }
  return {
    status: signal.aborted ? 'cancelled' : success ? 'passed' : 'warning',
    summary: signal.aborted
      ? 'Проверка остановлена.'
      : success
        ? 'Получен ICMP-ответ IP весов по маршруту ОС. Протокол RLS1100 ещё не проверен.'
        : 'Подтверждённого ICMP-ответа нет. Это не доказывает отсутствие весов: ICMP может быть отключён.',
    details: {
      route: 'OS routing table; not bound to selected adapter',
      scaleIp: profile.scaleIp,
      ...(reply ? { dotNetPing: reply } : {}),
      protocolVerified: false,
    },
    commands,
  };
}

function localUdp(
  signal: AbortSignal,
  address: string,
  exchange: boolean,
): Promise<CheckResult> {
  if (signal.aborted)
    return Promise.resolve({
      status: 'cancelled',
      summary: 'Проверка остановлена.',
    });
  return new Promise((resolve) => {
    const sockets: Socket[] = [];
    let settled = false;
    const finish = (result: CheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      let remaining = sockets.length;
      const closed = (): void => {
        remaining -= 1;
        if (!remaining) resolve(result);
      };
      if (!remaining) resolve(result);
      for (const socket of sockets) {
        try {
          socket.close(closed);
        } catch {
          closed();
        }
      }
    };
    const cancel = (): void =>
      finish({ status: 'cancelled', summary: 'UDP-проверка остановлена.' });
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(
      () =>
        finish({
          status: 'failed',
          summary: 'Таймаут локальной UDP-проверки (2 секунды).',
        }),
      2000,
    );
    const socket = (): Socket => {
      const item = createSocket('udp4');
      sockets.push(item);
      item.on('error', (error) =>
        finish({
          status: 'failed',
          summary: `Локальный UDP: ${error.message}`,
        }),
      );
      return item;
    };
    try {
      const receiver = socket();
      receiver.bind(0, address, () => {
        if (settled) return;
        if (!exchange) {
          finish({
            status: 'passed',
            summary:
              'UDP-сокет привязан к выбранному адресу ПК. Данные весам не отправлялись.',
            details: { address: receiver.address(), devicePayloadSent: false },
          });
          return;
        }
        const payload = randomBytes(24);
        const sender = socket();
        receiver.once('message', (message, remote) => {
          if (remote.address !== '127.0.0.1' || !message.equals(payload)) {
            finish({
              status: 'failed',
              summary:
                'Локальный UDP: ответ не совпадает с контрольным сообщением.',
            });
            return;
          }
          finish({
            status: 'passed',
            summary:
              'Контрольное сообщение отправлено и получено через 127.0.0.1. Сеть весов не проверена.',
            details: {
              bytes: payload.length,
              address: receiver.address(),
              remote,
              devicePayloadSent: false,
            },
          });
        });
        // Explicit loopback binding prevents even test payloads leaving this machine.
        sender.bind(0, '127.0.0.1', () => {
          if (settled) return;
          sender.send(
            payload,
            receiver.address().port,
            '127.0.0.1',
            (error) => {
              if (error)
                finish({
                  status: 'failed',
                  summary: `Локальный UDP: ${error.message}`,
                });
            },
          );
        });
      });
      if (signal.aborted) cancel();
    } catch (cause) {
      finish({
        status: 'failed',
        summary: cause instanceof Error ? cause.message : String(cause),
      });
    }
  });
}

export function checkUdpLoopback(signal: AbortSignal): Promise<CheckResult> {
  return localUdp(signal, '127.0.0.1', true);
}

export function checkUdpBind(
  profile: DiagnosticProfile,
  signal: AbortSignal,
): Promise<CheckResult> {
  return localUdp(signal, profile.localAddress, false);
}
