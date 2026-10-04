import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { arch, release } from 'node:os';
import { join } from 'node:path';

import { TEST_PRODUCT } from '../../shared/diagnostics';
import type {
  CheckResult,
  DiagnosticProfile,
  DiagnosticRun,
  DiagnosticState,
} from '../../shared/diagnostics';
import { checkPluFixture } from './plu';
import {
  checkReachability,
  checkSubnet,
  checkUdpBind,
  checkUdpLoopback,
  getNetworkAdapters,
  parseProfile,
  runArp,
  runNetworkCommands,
  validateProfile,
} from './probes';
import { writeReport } from './report';

interface ServiceOptions {
  dataDirectory: string;
  logsDirectory: string;
  appVersion: string;
  platform?: NodeJS.Platform;
}

export class DiagnosticsService {
  private readonly options: ServiceOptions;
  private readonly platform: NodeJS.Platform;
  private state: DiagnosticState = {
    run: null,
    profile: null,
    profileError: null,
    interfaces: [],
    testProduct: { ...TEST_PRODUCT },
  };
  private initialization: Promise<void> | null = null;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private configuring = false;

  constructor(options: ServiceOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
  }

  initialize(): Promise<void> {
    this.initialization ??= this.loadAndStart();
    return this.initialization;
  }

  getState(): DiagnosticState {
    // Refresh after cable/adapter changes so a user can repair a stale profile.
    this.state.interfaces = getNetworkAdapters();
    return structuredClone(this.state);
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  async saveProfile(input: unknown): Promise<DiagnosticState> {
    if (this.active || this.configuring)
      throw new Error('Дождитесь завершения или остановите текущие проверки.');
    this.configuring = true;
    try {
      const profile = validateProfile(input, getNetworkAdapters());
      await this.writeSettings(profile);
      this.state.profile = profile;
      this.state.profileError = null;
    } catch (error) {
      this.state.profileError = String(error);
      throw error;
    } finally {
      this.configuring = false;
    }
    return this.rerun();
  }

  rerun(): DiagnosticState {
    if (this.configuring) throw new Error('Сохраняются настройки подключения.');
    if (!this.active) this.startRun();
    return this.getState();
  }

  async cancel(): Promise<DiagnosticState> {
    this.controller?.abort();
    await this.active;
    return this.getState();
  }

  private async loadAndStart(): Promise<void> {
    this.state.interfaces = getNetworkAdapters();
    try {
      const saved: unknown = JSON.parse(
        await readFile(
          join(this.options.dataDirectory, 'diagnostics.json'),
          'utf8',
        ),
      );
      if (!saved || typeof saved !== 'object' || !('profile' in saved))
        throw new Error('Неверный формат настроек диагностики.');
      if (saved.profile !== null)
        this.state.profile = parseProfile(saved.profile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await this.writeSettings(null);
        } catch (writeError) {
          this.state.profileError = `Не удалось сохранить настройки: ${String(writeError)}`;
        }
      } else {
        this.state.profileError = `Проверьте сохранённый профиль: ${String(error)}`;
      }
    }
    this.startRun();
  }

  private async writeSettings(
    profile: DiagnosticProfile | null,
  ): Promise<void> {
    await mkdir(this.options.dataDirectory, { recursive: true });
    const file = join(this.options.dataDirectory, 'diagnostics.json');
    await writeFile(
      `${file}.tmp`,
      JSON.stringify({ profile, testProduct: TEST_PRODUCT }, null, 2),
      'utf8',
    );
    await rename(`${file}.tmp`, file);
  }

  private startRun(): void {
    const startedAt = new Date().toISOString();
    const id = `${startedAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
    const run: DiagnosticRun = {
      schemaVersion: 1,
      id,
      startedAt,
      status: 'running',
      profile: this.state.profile ? { ...this.state.profile } : null,
      testProduct: { ...TEST_PRODUCT },
      steps: [
        ['environment', 'Окружение приложения'],
        ['interfaces', 'Сетевые интерфейсы'],
        ['network-commands', 'Системная конфигурация сети'],
        ['plu', 'Офлайн-проверка формата PLU'],
        ['udp-loopback', 'Локальный UDP-обмен'],
        ['subnet', 'Подсеть и профиль подключения'],
        ['reachability', 'Доступность IP весов'],
        ['arp', 'Таблица соседей ARP'],
        ['udp-bind', 'UDP-сокет выбранного адаптера'],
      ].map(([stepId, title]) => ({
        id: stepId,
        title,
        status: 'pending',
        summary: 'Ожидает выполнения',
      })),
      reportDirectory: join(this.options.logsDirectory, 'diagnostics', id),
      persistenceError: null,
      protocolStatus: 'unverified',
    };
    this.state.run = run;
    const controller = new AbortController();
    this.controller = controller;
    this.active = this.execute(run, controller.signal).finally(() => {
      this.controller = null;
      this.active = null;
    });
  }

  private async persist(run: DiagnosticRun): Promise<void> {
    try {
      await writeReport(run.reportDirectory, run);
    } catch (error) {
      run.persistenceError = `Не удалось сохранить отчёт: ${String(error)}`;
    }
  }

  private async execute(
    run: DiagnosticRun,
    signal: AbortSignal,
  ): Promise<void> {
    await this.persist(run);
    for (const step of run.steps) {
      if (signal.aborted) {
        step.status = 'skipped';
        step.summary = 'Не выполнено: запуск остановлен';
        continue;
      }
      step.status = 'running';
      step.summary = 'Выполняется';
      const start = Date.now();
      step.startedAt = new Date(start).toISOString();
      try {
        Object.assign(step, await this.perform(step.id, run.profile, signal));
      } catch (error) {
        step.status = signal.aborted ? 'cancelled' : 'failed';
        step.summary = String(error);
      }
      step.finishedAt = new Date().toISOString();
      step.durationMs = Date.now() - start;
      await this.persist(run);
    }
    run.status = signal.aborted ? 'cancelled' : 'completed';
    run.finishedAt = new Date().toISOString();
    await this.persist(run);
  }

  private async perform(
    id: string,
    profile: DiagnosticProfile | null,
    signal: AbortSignal,
  ): Promise<CheckResult> {
    switch (id) {
      case 'environment':
        return {
          status: 'passed',
          summary: 'Версии окружения записаны',
          details: {
            platform: this.platform,
            osRelease: release(),
            arch: arch(),
            appVersion: this.options.appVersion,
            electron: process.versions.electron ?? null,
            node: process.versions.node,
          },
        };
      case 'interfaces': {
        const adapters = getNetworkAdapters();
        return {
          status: adapters.length ? 'passed' : 'warning',
          summary: adapters.length
            ? 'Доступные IPv4-интерфейсы записаны'
            : 'Нет доступных IPv4-интерфейсов',
          details: adapters,
        };
      }
      case 'network-commands':
        return runNetworkCommands(this.platform, signal);
      case 'plu':
        return checkPluFixture();
      case 'udp-loopback':
        return checkUdpLoopback(signal);
      case 'arp':
        return runArp(this.platform, signal);
      default: {
        if (!profile)
          return {
            status: 'skipped',
            summary: 'Не выполнено: требуется IP весов и выбор адаптера',
          };
        const adapters = getNetworkAdapters();
        // Revalidate persisted settings against current interfaces at the network boundary.
        validateProfile(profile, adapters);
        if (id === 'subnet') return checkSubnet(profile, adapters);
        if (id === 'reachability')
          return checkReachability(profile, this.platform, signal);
        if (id === 'udp-bind') return checkUdpBind(profile, signal);
        throw new Error(`Неизвестная проверка: ${id}`);
      }
    }
  }
}
