// The stylesheet loads first: it declares the cascade layer order (theme, base, legacy,
// components, utilities) before any feature stylesheet a route module pulls in.
import './styles.css';
// Atkinson Hyperlegible Next and Mono (Strata), bundled with the app (OFL-1.1) so they load on the LAN alone.
import '@fontsource/atkinson-hyperlegible-next/latin-400.css';
import '@fontsource/atkinson-hyperlegible-next/latin-500.css';
import '@fontsource/atkinson-hyperlegible-next/latin-600.css';
import '@fontsource/atkinson-hyperlegible-next/latin-700.css';
import '@fontsource/atkinson-hyperlegible-mono/latin-400.css';
import '@fontsource/atkinson-hyperlegible-mono/latin-500.css';
import '@fontsource/atkinson-hyperlegible-mono/latin-600.css';
import '@fontsource/atkinson-hyperlegible-mono/latin-700.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { applyPageTitle } from './layout/page-title';
import { routes } from './routes';
import { SessionProvider } from './session/SessionProvider';
import { applyStoredTheme } from './theme/theme';

// index.html applies it before paint already; repeat in case that script didn't run.
applyStoredTheme();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element in index.html');
}

const router = createBrowserRouter(routes);
// MTR-134: pages without their own title get the route's label (see layout/page-title.ts).
applyPageTitle(router.state.location.pathname);
router.subscribe((state) => applyPageTitle(state.location.pathname));

createRoot(root).render(
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  </StrictMode>,
);
