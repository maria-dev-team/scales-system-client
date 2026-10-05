import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DiagnosticRun } from '../../shared/diagnostics';

export function formatReport(run: DiagnosticRun): string {
  const lines = [
    'DukenAI Scales — диагностика RLS1100',
    `ID: ${run.id}`,
    `Начало: ${run.startedAt}`,
    `Окончание: ${run.finishedAt ?? 'ещё выполняется'}`,
    `Состояние запуска: ${run.status}`,
    `Протокол весов: ${run.protocolStatus}${
      run.transferTest
        ? ' (тест записи; подтверждение пакетов не является проверкой печати)'
        : ' (не проверен; команды PLU не отправлялись)'
    }`,
    `Каталог: ${run.reportDirectory}`,
    `Ошибка сохранения: ${run.persistenceError ?? 'нет'}`,
    `Профиль: ${JSON.stringify(run.profile)}`,
    `Тестовый товар: ${JSON.stringify(run.testProduct)}`,
    ...(run.transferTest
      ? [
          `Параметры передачи: ${JSON.stringify(run.transferTest)}`,
          `Печать (со слов оператора): ${JSON.stringify(run.printObservation ?? null)}`,
        ]
      : []),
    '',
  ];
  for (const step of run.steps) {
    lines.push(`[${step.status}] ${step.title}`, step.summary);
    if (step.startedAt)
      lines.push(
        `Начало: ${step.startedAt}; окончание: ${step.finishedAt ?? '—'}; длительность: ${step.durationMs ?? '—'} мс`,
      );
    if (step.details !== undefined)
      lines.push(JSON.stringify(step.details, null, 2));
    for (const command of step.commands ?? []) {
      lines.push(
        `Команда: ${command.executable}`,
        `Аргументы: ${JSON.stringify(command.args)}`,
        `Начало: ${command.startedAt}; окончание: ${command.finishedAt}; длительность: ${command.durationMs} мс`,
        `exitCode: ${command.exitCode}; signal: ${command.signal}; timeout: ${command.timedOut}; cancelled: ${command.cancelled}`,
        `Кодировка: ${command.encoding}; вывод ограничен: ${command.truncated ?? false}`,
        `Ошибка: ${command.error ?? 'нет'}`,
        '--- stdout ---',
        command.stdout,
        '--- stderr ---',
        command.stderr,
        '--- исходные байты stdout/stderr сохранены в report.json (base64) ---',
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export async function writeReport(
  directory: string,
  run: DiagnosticRun,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  // Replace each file only after the new snapshot has been completely written.
  for (const [name, content] of [
    ['report.json', `${JSON.stringify(run, null, 2)}\n`],
    ['report.txt', formatReport(run)],
  ]) {
    const temporary = join(directory, `${name}.tmp`);
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, join(directory, name));
  }
}
