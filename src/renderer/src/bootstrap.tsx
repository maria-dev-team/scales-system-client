import { QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import { configureAccessTokenProvider } from './common/api';
import { createQueryClient } from './common/lib/query-client';
import { authTokenProvider } from './features/auth';

const queryClient = createQueryClient();
configureAccessTokenProvider({
  ...authTokenProvider,
  resyncAuth: () => queryClient.removeQueries(),
});

export default function MariaApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  );
}
