import { contextBridge, ipcRenderer } from 'electron';

import type { DiagnosticsApi } from '../shared/diagnostics';

const diagnostics: DiagnosticsApi = {
  getState: () => ipcRenderer.invoke('diagnostics:get-state'),
  saveProfile: (profile) =>
    ipcRenderer.invoke('diagnostics:save-profile', profile),
  rerun: () => ipcRenderer.invoke('diagnostics:rerun'),
  cancel: () => ipcRenderer.invoke('diagnostics:cancel'),
  exportReport: () => ipcRenderer.invoke('diagnostics:export'),
  startTransferTest: (options) =>
    ipcRenderer.invoke('diagnostics:transfer-test', options),
  recordPrintResult: (input) =>
    ipcRenderer.invoke('diagnostics:print-result', input),
};

contextBridge.exposeInMainWorld('diagnostics', diagnostics);
