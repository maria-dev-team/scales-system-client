import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { BrowserWindow, app, net, protocol } from 'electron';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { registerCatalogIpc } from './catalog/ipc';
import { CatalogService } from './catalog/service';
import { resolveRendererFilePath } from './renderer-protocol';
import { registerWindowControlsIpc } from './window-controls';

let catalog: CatalogService | null = null;
let quitting = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'maria',
    privileges: {
      corsEnabled: true,
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
]);

function createWindow(): void {
  const window = new BrowserWindow({
    title: 'DukenAI Scales',
    width: 1100,
    height: 800,
    minWidth: 640,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  registerWindowControlsIpc(
    window,
    is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
  );
  window.on('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);

  if (!is.dev) {
    window.webContents.on('will-navigate', (event) => event.preventDefault());
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void window.loadURL('maria://app/');
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  void app.whenReady().then(() => {
    electronApp.setAppUserModelId('kz.maria.scales');
    app.setAppLogsPath();
    catalog = new CatalogService({
      dataDirectory: app.getPath('userData'),
      apiUrl: process.env.SCALES_API_URL ?? '',
    });
    registerCatalogIpc(
      catalog,
      is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
    );
    void catalog.initialize().catch(() => undefined);
    const rendererRoot = join(__dirname, '../renderer');
    protocol.handle('maria', (request) => {
      const filePath = resolveRendererFilePath(rendererRoot, request.url);
      if (!filePath) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    });

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void Promise.allSettled([catalog?.close()]).finally(() => app.quit());
});
