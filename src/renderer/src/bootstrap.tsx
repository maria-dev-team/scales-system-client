import { QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import { configureAccessTokenProvider } from './common/api';
import { CatalogAuthBridge } from './common/lib/catalog-session';
import { createQueryClient } from './common/lib/query-client';
import { authTokenProvider } from './features/auth';
import { StatusBarSession } from './features/status-bar/status-bar-session';

const queryClient = createQueryClient();
configureAccessTokenProvider({
  ...authTokenProvider,
  resyncAuth: () => queryClient.removeQueries(),
});

export default function MariaApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogAuthBridge />
      <StatusBarSession />
      <App />
    </QueryClientProvider>
  );
}
