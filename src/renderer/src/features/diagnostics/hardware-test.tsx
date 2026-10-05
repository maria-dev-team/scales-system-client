import { Printer, Send } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@renderer/common/components/ui/button';

import type {
  DiagnosticRun,
  DiagnosticState,
  PrintTestInput,
  TransferTestOptions,
} from '../../../../shared/diagnostics';

const printOutcomes: Record<PrintTestInput['outcome'], string> = {
  'printed-correctly': 'Этикетка напечатана, данные верны',
  'wrong-data': 'Этикетка напечатана, данные неверны',
  'not-printed': 'Этикетка не напечатана',
};

function PrintCheck({
  run,
  busy,
  onRecord,
}: {
  run: DiagnosticRun;
  busy: boolean;
  onRecord: (input: PrintTestInput) => void;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<PrintTestInput['outcome'] | ''>(
    run.printObservation?.outcome ?? '',
  );
  const [note, setNote] = useState(run.printObservation?.note ?? '');
  return (
    <div className="mt-5 border-t pt-5">
      <p className="mb-3 text-sm leading-6 text-muted-foreground">
        Получен ACK записи. Он не подтверждает правильность данных на дисплее и
        печать этикетки.
      </p>
      <Button
        variant="ghost"
        className="w-full border-border text-sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Printer aria-hidden="true" className="size-4" />
        Проверка печати
      </Button>
      {run.printObservation && (
        <p
          role="status"
          className="mt-3 rounded-lg bg-secondary p-3 text-xs leading-5"
        >
          Записано со слов оператора:{' '}
          {printOutcomes[run.printObservation.outcome]}.{' '}
          {run.printObservation.note}
          <br />
          {new Date(run.printObservation.recordedAt).toLocaleString('ru-RU')}
        </p>
      )}
      {open && (
        <div className="mt-4 space-y-4 text-sm">
          <p className="leading-6 text-muted-foreground">
            Выполните действия на весах {run.profile?.scaleIp}. Приложение не
            отправляет команду печати.
          </p>
          <ol className="list-decimal space-y-2 pl-5 leading-6">
            <li>
              Освободите платформу и установите ноль. Для одиночной ручной
              печати индикатор AUTO должен быть выключен.
            </li>
            <li>Положите груз и дождитесь стабильного веса.</li>
            <li>
              Коротко нажмите PLU → 900001 → PLU. Длительное нажатие PLU
              открывает редактирование.
            </li>
            <li>
              Проверьте название TEST APPLE и цену 12.34 за кг на дисплее.
            </li>
            <li>
              Нажмите PRN/ENTER. Проверьте этикетку: название, цену, вес, сумму
              и штрихкод.
            </li>
          </ol>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (outcome) onRecord({ runId: run.id, outcome, note });
            }}
          >
            <fieldset disabled={busy} className="space-y-3">
              <div>
                <label
                  htmlFor="print-outcome"
                  className="mb-2 block font-medium"
                >
                  Результат на весах
                </label>
                <select
                  id="print-outcome"
                  required
                  value={outcome}
                  onChange={(event) =>
                    setOutcome(event.target.value as PrintTestInput['outcome'])
                  }
                  className="min-h-12 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Выберите результат</option>
                  {Object.entries(printOutcomes).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="print-note" className="mb-2 block font-medium">
                  Наблюдение оператора
                </label>
                <textarea
                  id="print-note"
                  rows={4}
                  maxLength={1000}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Фактическая цена, вес, сумма, считанный штрихкод или ошибка печати"
                  className="w-full resize-y rounded-lg border border-input bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  До 1000 символов. Результат будет записан в отчёт этого
                  запуска.
                </p>
              </div>
              <Button
                type="submit"
                className="w-full px-2 text-sm"
                disabled={busy || !outcome}
              >
                Записать результат печати
              </Button>
            </fieldset>
          </form>
        </div>
      )}
    </div>
  );
}

export function HardwareTest({
  state,
  busy,
  onTransfer,
  onRecord,
}: {
  state: DiagnosticState;
  busy: boolean;
  onTransfer: (options: TransferTestOptions) => void;
  onRecord: (input: PrintTestInput) => void;
}) {
  const [priceDecimals, setPriceDecimals] = useState<2 | 3>(2);
  const disabled =
    busy || state.run?.status === 'running' || !state.run || !state.profile;
  const printableRun =
    state.run?.transferTest &&
    state.run.status === 'completed' &&
    state.run.protocolStatus === 'write-acknowledged'
      ? state.run
      : null;
  return (
    <section className="rounded-xl border border-warning/30 bg-card p-5">
      <h2 className="text-sm font-semibold">Тест на реальных весах</h2>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Экспериментальный драйвер. Отправляется TEST APPLE, 12.34 за кг; товар с
        LFCode / PLU 900001 может быть перезаписан. Сохранность остальных
        товаров на этой прошивке ещё не проверена. Используйте тестовый каталог.
      </p>
      <div className="my-4 rounded-lg bg-muted p-3 text-xs leading-5">
        <p className="font-semibold">Сохранённая цель передачи</p>
        {state.profile ? (
          <>
            <p className="mt-1 font-mono">
              {state.profile.scaleIp}:{state.profile.port}
            </p>
            <p className="text-muted-foreground">
              Локальный адрес: {state.profile.localAddress}
            </p>
            <p className="mt-2 text-muted-foreground">
              Изменения формы подключения применятся только после сохранения.
            </p>
          </>
        ) : (
          <p className="mt-1 text-muted-foreground">
            Сначала сохраните IP весов и адаптер.
          </p>
        )}
      </div>
      <label
        htmlFor="price-decimals"
        className="mb-2 block text-xs font-medium"
      >
        Знаков после запятой в цене на весах
      </label>
      <select
        id="price-decimals"
        value={priceDecimals}
        disabled={disabled}
        onChange={(event) =>
          setPriceDecimals(Number(event.target.value) as 2 | 3)
        }
        className="h-12 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <option value={2}>2 знака (12.34)</option>
        <option value={3}>3 знака (12.340)</option>
      </select>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        Выберите значение из настроек весов: при несовпадении цена будет
        неверной.
      </p>
      <Button
        className="mt-4 w-full px-3 text-sm"
        disabled={disabled}
        onClick={() => onTransfer({ priceDecimals })}
      >
        <Send aria-hidden="true" className="size-4" />
        Передать TEST APPLE
      </Button>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Передача выполняется только этой кнопкой. Автопроверка и «Повторить»
        товар не отправляют. Сеанс также передаёт весам дату и время ПК —
        проверьте их перед тестом.
      </p>
      {printableRun && (
        <PrintCheck
          key={printableRun.id}
          run={printableRun}
          busy={busy}
          onRecord={onRecord}
        />
      )}
    </section>
  );
}
