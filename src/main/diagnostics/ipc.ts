import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { writeReport } from './report';
import type { DiagnosticsService } from './service';
import { isTrustedRendererUrl } from './trusted-renderer';

export function registerDiagnosticsIpc(
  service: DiagnosticsService,
  devUrl?: string,
): void {
  const authorize = (event: IpcMainInvokeEvent): void => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame ||
      !isTrustedRendererUrl(event.senderFrame?.url ?? '', devUrl)
    )
      throw new Error('Источник запроса диагностики не разрешён.');
  };
  ipcMain.handle('diagnostics:get-state', (event) => {
    authorize(event);
    return service.getState();
  });
  ipcMain.handle('diagnostics:save-profile', (event, profile: unknown) => {
    authorize(event);
    return service.saveProfile(profile);
  });
  ipcMain.handle('diagnostics:rerun', (event) => {
    authorize(event);
    return service.rerun();
  });
  ipcMain.handle('diagnostics:cancel', (event) => {
    authorize(event);
    return service.cancel();
  });
  ipcMain.handle('diagnostics:transfer-test', (event, options: unknown) => {
    authorize(event);
    return service.startTransferTest(options);
  });
  ipcMain.handle('diagnostics:print-result', (event, input: unknown) => {
    authorize(event);
    return service.recordPrintResult(input);
  });
  ipcMain.handle('diagnostics:export', async (event) => {
    authorize(event);
    const choice = await dialog.showOpenDialog({
      title: 'Выберите папку для отчёта диагностики',
      buttonLabel: 'Сохранить отчёт здесь',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (choice.canceled || !choice.filePaths[0]) return { canceled: true };
    const run = service.getState().run;
    if (!run) throw new Error('Отчёт ещё не создан.');
    const destination = join(
      choice.filePaths[0],
      `scales-report-${run.id}-${randomUUID().slice(0, 8)}`,
    );
    await writeReport(destination, run);
    return { canceled: false, path: destination };
  });
}
