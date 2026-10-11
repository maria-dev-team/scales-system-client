import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'electron-vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => ({
  main: {
    define: {
      'process.env.SCALES_API_URL': JSON.stringify(
        loadEnv(mode).VITE_API_URL ?? '',
      ),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'catalog-worker': resolve('src/main/catalog/catalog-worker.ts'),
        },
      },
    },
  },
  preload: {},
  renderer: {
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src') },
    },
    plugins: [tailwindcss(), react({ jsxRuntime: 'automatic' })],
  },
}));
