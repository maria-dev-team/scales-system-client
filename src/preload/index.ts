import { contextBridge, ipcRenderer } from 'electron';

import type { CatalogApi } from '../shared/catalog';

const catalog: CatalogApi = {
  request: (request) => ipcRenderer.invoke('catalog:request', request),
  onChange: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on('catalog:changed', handler);
    return () => ipcRenderer.removeListener('catalog:changed', handler);
  },
  onRefreshRequired: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on('catalog:refresh-required', handler);
    return () =>
      ipcRenderer.removeListener('catalog:refresh-required', handler);
  },
};
contextBridge.exposeInMainWorld('catalog', catalog);

contextBridge.exposeInMainWorld('windowControls', {
  minimize: (): void => {
    ipcRenderer.send('window-controls:minimize');
  },
});
