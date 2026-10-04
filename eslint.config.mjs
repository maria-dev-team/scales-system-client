import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier';
import tseslint from '@electron-toolkit/eslint-config-ts';
import eslintPluginReactHooks from 'eslint-plugin-react-hooks';
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh,
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': ['error', { allow: ['error', 'warn'] }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@renderer/features/*/components/*',
                '@renderer/features/*/hooks/*',
                '@renderer/features/*/stores/*',
                '@renderer/features/*/login/*',
                '@renderer/features/*/*-view',
              ],
              message:
                'Импортируйте модуль через его публичный index.ts, не через внутренний файл.',
            },
          ],
        },
      ],
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  eslintConfigPrettier,
);
