/// <reference types="vite/client" />
import type { CatalogApi } from '../../shared/catalog';

declare global {
  interface Window {
    catalog?: CatalogApi;
    windowControls?: { minimize: () => void };
  }
}
