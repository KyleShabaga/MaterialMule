import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { applyPageTitle } from './layout/page-title';
import { routes } from './routes';
import { SessionProvider } from './session/SessionProvider';
import { applyStoredTheme } from './theme/theme';
// Interface and identifier fonts, bundled with the app (OFL-1.1) so they load on the LAN alone.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-800.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './styles.css';

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
