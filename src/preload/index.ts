import { contextBridge, ipcRenderer } from 'electron';

import type { DiagnosticsApi } from '../shared/diagnostics';

const diagnostics: DiagnosticsApi = {
  getState: () => ipcRenderer.invoke('diagnostics:get-state'),
  saveProfile: (profile) =>
    ipcRenderer.invoke('diagnostics:save-profile', profile),
  rerun: () => ipcRenderer.invoke('diagnostics:rerun'),
  cancel: () => ipcRenderer.invoke('diagnostics:cancel'),
  exportReport: () => ipcRenderer.invoke('diagnostics:export'),
};

contextBridge.exposeInMainWorld('diagnostics', diagnostics);
