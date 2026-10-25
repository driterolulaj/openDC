// SPDX-License-Identifier: AGPL-3.0-only
import '@mantine/core/styles.css';
import './i18n.ts';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Center, Loader, MantineProvider, createTheme } from '@mantine/core';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { useTranslation } from 'react-i18next';
import Layout from './Layout.tsx';
import { SessionProvider, useSession } from './session.tsx';
import { ErrorView } from './ErrorView.tsx';
import { routes as moduleRoutes } from './generated/modules.ts';
import { setupStatusResponse } from '@opendc/shared/api';
import { api } from './api.ts';

const Login = lazy(() => import('./pages/Login.tsx'));
const Home = lazy(() => import('./pages/Home.tsx'));
const Audit = lazy(() => import('./pages/Audit.tsx'));
const Setup = lazy(() => import('./pages/Setup.tsx'));

const theme = createTheme({ primaryColor: 'blue', defaultRadius: 'sm' });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function Spinner() {
  const { t } = useTranslation();
  return (
    <Center mih="50vh">
      <Loader aria-label={t('app.loading')} />
    </Center>
  );
}

const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        { index: true, element: <Home /> },
        { path: 'audit', element: <Audit /> },
        ...moduleRoutes.filter((r) => r.area === 'console').map((r) => ({ path: r.path, element: <r.component /> })),
      ],
    },
  ],
  { basename: '/console' },
);

/** Not set up -> the setup wizard; not logged in -> the login page; logged in -> the console routes. */
function App() {
  const { session, loading, error } = useSession();
  const setup = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api('/setup/status', { schema: setupStatusResponse }),
    retry: false,
    staleTime: Infinity,
  });
  if (setup.isPending) return <Spinner />;
  if (setup.data && !setup.data.provisioned) return <Setup />;
  if (loading) return <Spinner />;
  if (error) return <ErrorView error={error} />;
  if (!session) return <Login />;
  return <RouterProvider router={router} />;
}

function Root() {
  return (
    <Suspense fallback={<Spinner />}>
      <App />
    </Suspense>
  );
}

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <MantineProvider theme={theme} defaultColorScheme="auto">
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <Root />
          </SessionProvider>
        </QueryClientProvider>
      </MantineProvider>
    </StrictMode>,
  );
}
