import { Download, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '@renderer/common/components/ui/button';
import { Input } from '@renderer/common/components/ui/input';

import type {
  DiagnosticProfile,
  DiagnosticState,
  DiagnosticStep,
} from '../../../../shared/diagnostics';
import { HardwareTest } from './hardware-test';

const statusLabels: Record<DiagnosticStep['status'], string> = {
  pending: 'Ожидание',
  running: 'Выполняется',
  passed: 'Успешно',
  failed: 'Ошибка',
  warning: 'Внимание',
  skipped: 'Не выполнено',
  cancelled: 'Отменено',
};

const statusStyles: Record<DiagnosticStep['status'], string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-secondary text-primary',
  passed: 'bg-success-muted text-success',
  failed: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning-muted text-warning',
  skipped: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
};

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Не удалось выполнить действие';
}

function ConnectionForm({
  state,
  disabled,
  onSave,
}: {
  state: DiagnosticState;
  disabled: boolean;
  onSave: (profile: DiagnosticProfile) => void;
}) {
  const [scaleIp, setScaleIp] = useState(state.profile?.scaleIp ?? '');
  const [localAddress, setLocalAddress] = useState(
    state.profile?.localAddress ?? '',
  );
  const [port, setPort] = useState(String(state.profile?.port ?? 5001));
  const selectedAdapter = state.interfaces.find(
    (adapter) => adapter.address === localAddress,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ scaleIp: scaleIp.trim(), localAddress, port: Number(port) });
  };
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">Подключение весов</h2>
      <p className="mb-5 mt-2 text-sm leading-6 text-muted-foreground">
        Соедините ПК и весы кабелем Ethernet. Укажите IP из настроек весов и
        адаптер, к которому подключён кабель.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <fieldset disabled={disabled} className="space-y-4 disabled:opacity-70">
          <div>
            <label
              htmlFor="scale-ip"
              className="mb-2 block text-sm font-medium"
            >
              IP весов
            </label>
            <Input
              id="scale-ip"
              inputMode="decimal"
              placeholder="192.168.1.87"
              value={scaleIp}
              onChange={(event) => setScaleIp(event.target.value)}
              required
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="adapter" className="mb-2 block text-sm font-medium">
              Ethernet-адаптер
            </label>
            <select
              id="adapter"
              className="h-12 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={localAddress}
              onChange={(event) => setLocalAddress(event.target.value)}
              required
            >
              <option value="">Выберите адаптер</option>
              {localAddress && !selectedAdapter && (
                <option value={localAddress}>
                  {localAddress} — недоступен
                </option>
              )}
              {state.interfaces.map((adapter) => (
                <option
                  key={`${adapter.name}-${adapter.address}`}
                  value={adapter.address}
                >
                  {adapter.name} · {adapter.address}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              {selectedAdapter
                ? `Маска: ${selectedAdapter.netmask}`
                : 'Выберите проводной интерфейс в списке IPv4.'}
            </p>
          </div>
          <div>
            <label
              htmlFor="scale-port"
              className="mb-2 block text-sm font-medium"
            >
              Порт весов
            </label>
            <Input
              id="scale-port"
              type="number"
              min={1}
              max={65535}
              step={1}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              required
            />
          </div>
          <Button
            className="w-full px-3 text-sm"
            type="submit"
            disabled={disabled}
          >
            <Play aria-hidden="true" className="size-4" />
            Сохранить и проверить
          </Button>
        </fieldset>
      </form>
      <details className="mt-5 border-t pt-4 text-sm">
        <summary className="cursor-pointer font-medium">
          Как настроить прямое подключение
        </summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5 leading-6 text-muted-foreground">
          <li>
            Сохраните текущие настройки Ethernet на ПК. С одним разъёмом
            интернет через этот кабель временно станет недоступен.
          </li>
          <li>
            Откройте настройки IPv4 проводного адаптера и задайте свободный
            адрес в подсети весов. Например: весы 192.168.1.87, ПК 192.168.1.2,
            маска 255.255.255.0.
          </li>
          <li>
            Не назначайте ПК тот же адрес, что у весов. Для прямого соединения
            шлюз и DNS не нужны.
          </li>
          <li>
            После теста верните прежние настройки, включая автоматическое
            получение адреса, если оно использовалось.
          </li>
        </ol>
        <p className="mt-3 text-muted-foreground">
          Приложение не изменяет настройки сети Windows.
        </p>
      </details>
    </section>
  );
}

function StepRow({ step }: { step: DiagnosticStep }) {
  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{step.title}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {step.summary || 'Проверка ещё не началась'}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${statusStyles[step.status]}`}
        >
          {step.status === 'running' && (
            <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
          )}
          {statusLabels[step.status]}
        </span>
      </div>
      {step.commands?.length || step.details !== undefined ? (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer font-medium text-primary">
            Вывод и подробности
          </summary>
          <div className="mt-3 space-y-3">
            {step.commands?.map((command, index) => (
              <div key={index} className="space-y-2 rounded-lg bg-muted p-3">
                <p className="break-all font-mono font-semibold">
                  {command.executable} {command.args.join(' ')}
                </p>
                <p className="text-muted-foreground">
                  Код: {command.exitCode ?? '—'} · {command.durationMs} мс ·{' '}
                  {command.encoding}
                  {command.timedOut ? ' · Таймаут' : ''}
                  {command.cancelled ? ' · Отменено' : ''}
                  {command.signal ? ` · Сигнал: ${command.signal}` : ''}
                </p>
                {command.error && (
                  <p className="text-destructive">{command.error}</p>
                )}
                <p className="font-semibold">stdout</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono leading-5">
                  {command.stdout || '(пусто)'}
                </pre>
                <p className="font-semibold">stderr</p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono leading-5">
                  {command.stderr || '(пусто)'}
                </pre>
                {command.truncated && (
                  <p className="text-warning">Вывод ограничен по размеру.</p>
                )}
                <p className="text-muted-foreground">
                  Исходные байты и временные метки записаны в JSON-отчёте.
                </p>
              </div>
            ))}
            {step.details !== undefined && (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono leading-5">
                {JSON.stringify(step.details, null, 2)}
              </pre>
            )}
          </div>
        </details>
      ) : null}
    </li>
  );
}

export function DiagnosticsView() {
  const api = window.diagnostics;
  const [state, setState] = useState<DiagnosticState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operating = useRef(false);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        if (!operating.current) {
          const next = await api.getState();
          if (active && !operating.current) setState(next);
        }
      } catch (reason) {
        if (active) setError(errorMessage(reason));
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 700);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api]);

  const perform = async (operation: () => Promise<void>) => {
    if (operating.current) return;
    operating.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      operating.current = false;
      setBusy(false);
    }
  };
  const running = state?.run?.status === 'running';
  const run = state?.run;
  const finished =
    run?.steps.filter(
      (step) => step.status !== 'pending' && step.status !== 'running',
    ).length ?? 0;
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-6 py-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-primary">
            Автономный режим
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Проверка подключения RLS1100
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Проверки запускаются автоматически. Вход в Maria и интернет не
            требуются.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            disabled={!api || !run || running || busy}
            onClick={() =>
              void perform(async () => setState(await api!.rerun()))
            }
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Повторить
          </Button>
          <Button
            variant="ghost"
            disabled={!api || !running || busy}
            onClick={() =>
              void perform(async () => setState(await api!.cancel()))
            }
          >
            <Square aria-hidden="true" className="size-4" />
            Остановить
          </Button>
          <Button
            disabled={!api || !run || busy}
            onClick={() =>
              void perform(async () => {
                const result = await api!.exportReport();
                if (!result.canceled)
                  setNotice(`Отчёт сохранён: ${result.path}`);
              })
            }
          >
            <Download aria-hidden="true" className="size-4" />
            Сохранить отчёт
          </Button>
        </div>
      </div>
      {!api && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          Модуль диагностики недоступен. Запустите установленное приложение
          Electron, чтобы выполнить проверки.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {state?.profileError && (
        <p
          role="alert"
          className="rounded-xl bg-warning-muted p-4 text-sm text-warning"
        >
          Ошибка профиля: {state.profileError}
        </p>
      )}
      {run?.persistenceError && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          Ошибка сохранения отчёта: {run.persistenceError}. Сохраните отчёт в
          другой каталог.
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="break-all rounded-xl bg-success-muted p-4 text-sm text-success"
        >
          {notice}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-4">
          <h2 className="text-sm font-semibold">01 · Локальный код</h2>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Окружение, UDP loopback и формат PLU. Результаты каждого теста ниже.
          </p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <h2 className="text-sm font-semibold">02 · Доступность IP</h2>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Ответ ICMP проверяет сетевой адрес. Отсутствие ответа не доказывает
            неисправность весов.
          </p>
        </div>
        <div className="rounded-xl border border-warning/20 bg-warning-muted/40 p-4">
          <h2 className="text-sm font-semibold">
            {run?.protocolStatus === 'write-acknowledged'
              ? '03 · Получен ACK записи'
              : '03 · Протокол не проверен'}
          </h2>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {run?.protocolStatus === 'write-acknowledged'
              ? 'Ответ на передачу получен. Правильность товара и печати проверьте на весах.'
              : 'Автопроверка не изменяет каталог. Передача тестового товара запускается отдельно; ping не подтверждает загрузку.'}
          </p>
        </div>
      </div>
      {!state && api && (
        <p
          role="status"
          className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
        >
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Получаем состояние проверок…
        </p>
      )}
      {state && (
        <div className="grid items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="space-y-5">
            <ConnectionForm
              key={JSON.stringify(state.profile)}
              state={state}
              disabled={running || busy || !run}
              onSave={(profile) =>
                void perform(async () =>
                  setState(await api!.saveProfile(profile)),
                )
              }
            />
            <section className="rounded-xl border bg-card p-5">
              <h2 className="text-sm font-semibold">Тестовый товар</h2>
              <p className="mt-3 font-mono text-lg font-semibold">
                {state.testProduct.name}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-y-2 text-xs">
                <dt className="text-muted-foreground">LFCode / PLU</dt>
                <dd className="text-right font-mono">
                  {state.testProduct.lfCode}
                </dd>
                <dt className="text-muted-foreground">Code</dt>
                <dd className="text-right font-mono">
                  {state.testProduct.code}
                </dd>
                <dt className="text-muted-foreground">Цена за кг</dt>
                <dd className="text-right font-mono">
                  {state.testProduct.pricePerKg}
                </dd>
              </dl>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                Сохранённый образец для явного теста передачи. Автоматически не
                отправляется.
              </p>
            </section>
            <HardwareTest
              state={state}
              busy={busy}
              onTransfer={(options) =>
                void perform(async () =>
                  setState(await api!.startTransferTest(options)),
                )
              }
              onRecord={(input) =>
                void perform(async () =>
                  setState(await api!.recordPrintResult(input)),
                )
              }
            />
          </aside>
          <section className="min-w-0 overflow-hidden rounded-xl border bg-card">
            <div className="border-b p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">Результаты проверок</h2>
                <span className="text-xs text-muted-foreground">
                  {finished} / {run?.steps.length ?? 0}
                </span>
              </div>
              <p role="status" className="mt-2 text-sm text-muted-foreground">
                {!run
                  ? 'Подготовка запуска…'
                  : running
                    ? 'Проверки выполняются…'
                    : run.status === 'cancelled'
                      ? 'Запуск остановлен'
                      : 'Проверки завершены'}
              </p>
              {run && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(run.startedAt).toLocaleString('ru-RU')}
                </p>
              )}
            </div>
            <ol className="divide-y">
              {run?.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </ol>
            {run && (
              <div className="border-t bg-muted/40 p-5">
                <p className="text-xs font-semibold">
                  Автоматическое сохранение
                </p>
                <p className="mt-2 break-all font-mono text-xs leading-5 text-muted-foreground">
                  {run.reportDirectory}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  report.json и report.txt обновляются после каждого шага.
                  Передайте отчёт для анализа на Mac.
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
