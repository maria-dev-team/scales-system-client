/// <reference types="vite/client" />
import type { DiagnosticsApi } from '../../shared/diagnostics';

declare global {
  interface Window {
    diagnostics?: DiagnosticsApi;
  }
}
