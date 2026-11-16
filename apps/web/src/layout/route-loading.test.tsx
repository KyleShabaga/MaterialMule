import { render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ErrorPage } from '../pages/simple-pages';
import { isChunkLoadError, lazyPage } from '../lib/lazy-page';
import { PageLoading } from './route-loading';

/** A page whose code never arrives, the way each browser words it. */
const failingPage = (message: string) =>
  lazyPage(async (): Promise<{ Page: () => null }> => {
    throw new TypeError(message);
  }, 'Page');

function renderLazy(Page: ReturnType<typeof failingPage>, inShell: boolean) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <Suspense fallback={<PageLoading />}>
            <Page />
          </Suspense>
        ),
        errorElement: <ErrorPage inShell={inShell} />,
      },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

describe('area chunks (STRATA-132)', () => {
  it('recognises a page chunk that failed to download in each browser', () => {
    expect(
      isChunkLoadError(
        new TypeError('Failed to fetch dynamically imported module: /assets/InboxPage-x.js'),
      ),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
    expect(
      isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')")),
    ).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });

  it('in the shell, offers Reload when a page’s code can’t be downloaded', async () => {
    renderLazy(failingPage('Failed to fetch dynamically imported module: /assets/a.js'), true);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This page couldn’t be loaded.' }),
    ).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Check that this device is on the office network',
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
  });

  it('outside the shell (sign-in, label sheets), the same message on the sign-in card', async () => {
    renderLazy(failingPage('Importing a module script failed.'), false);
    expect(
      await screen.findByRole('heading', { name: 'This page couldn’t be loaded.' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
  });

  it('shows a quiet skeleton, marked busy, while a page loads', () => {
    const { container } = render(<PageLoading />);
    const loading = container.firstElementChild;
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(loading).toHaveClass('route-loading');
    expect(loading).toHaveTextContent('Loading…');
  });
});
