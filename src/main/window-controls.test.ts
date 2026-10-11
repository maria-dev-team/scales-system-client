// @vitest-environment node
import { type BrowserWindow, type IpcMainEvent, ipcMain } from 'electron';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

import { registerWindowControlsIpc } from './window-controls';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { ipcMain: new EventEmitter() };
});
afterEach(() => {
  ipcMain.removeAllListeners('window-controls:minimize');
});

function setup(
  url = 'maria://app/',
  devUrl?: string,
): {
  window: EventEmitter & {
    minimize: ReturnType<typeof vi.fn>;
    webContents: { mainFrame: { url: string } };
  };
  event: IpcMainEvent;
} {
  const window = Object.assign(new EventEmitter(), {
    minimize: vi.fn(),
    isDestroyed: () => false,
    webContents: { mainFrame: { url } },
  });
  registerWindowControlsIpc(window as unknown as BrowserWindow, devUrl);
  return {
    window,
    event: {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    } as unknown as IpcMainEvent,
  };
}

it('only minimizes the correct window when its trusted main frame sends the command', () => {
  const { window, event } = setup();
  ipcMain.emit('window-controls:minimize', { ...event, sender: {} });
  ipcMain.emit('window-controls:minimize', {
    ...event,
    senderFrame: { url: 'maria://app/' },
  });
  ipcMain.emit('window-controls:minimize', { ...event, senderFrame: null });
  expect(window.minimize).not.toHaveBeenCalled();
  ipcMain.emit('window-controls:minimize', event);
  expect(window.minimize).toHaveBeenCalledOnce();
  window.webContents.mainFrame.url = 'https://evil.example/';
  ipcMain.emit('window-controls:minimize', event);
  expect(window.minimize).toHaveBeenCalledOnce();
});

it('accepts only the configured development origin and stops handling after close', () => {
  const { window, event } = setup(
    'http://localhost:5173/',
    'http://localhost:5173',
  );
  ipcMain.emit('window-controls:minimize', event);
  expect(window.minimize).toHaveBeenCalledOnce();
  window.webContents.mainFrame.url = 'http://localhost:5174/';
  ipcMain.emit('window-controls:minimize', event);
  expect(window.minimize).toHaveBeenCalledOnce();
  window.webContents.mainFrame.url = 'http://localhost:5173/';
  window.emit('closed');
  ipcMain.emit('window-controls:minimize', event);
  expect(window.minimize).toHaveBeenCalledOnce();
});
