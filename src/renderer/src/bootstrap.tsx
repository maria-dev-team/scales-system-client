import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import type { Root } from 'react-dom/client';

import App from './App';
import { configureAccessTokenProvider } from './common/api';
import { createQueryClient } from './common/lib/query-client';
import { authTokenProvider } from './features/auth';

export function bootstrap(root: Root): void {
  const queryClient = createQueryClient();
  configureAccessTokenProvider({
    ...authTokenProvider,
    resyncAuth: () => queryClient.removeQueries(),
  });
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
