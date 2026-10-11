import { type BrowserWindow, type IpcMainEvent, ipcMain } from 'electron';

import { isTrustedRendererUrl } from './diagnostics/trusted-renderer';

const MINIMIZE_CHANNEL = 'window-controls:minimize';

export function registerWindowControlsIpc(
  window: BrowserWindow,
  devUrl?: string,
): void {
  const minimize = (event: IpcMainEvent): void => {
    if (
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isTrustedRendererUrl(event.senderFrame?.url ?? '', devUrl)
    )
      return;
    window.minimize();
  };
  ipcMain.on(MINIMIZE_CHANNEL, minimize);
  window.once('closed', () => {
    ipcMain.removeListener(MINIMIZE_CHANNEL, minimize);
  });
}
