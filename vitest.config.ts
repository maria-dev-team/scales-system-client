import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
    },
  },
  test: {
    env: {
      VITE_API_URL: 'http://localhost:4004',
    },
    environment: 'jsdom',
    setupFiles: ['./src/renderer/src/test-setup.ts'],
  },
});
