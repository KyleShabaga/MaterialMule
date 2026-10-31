import { act, render } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '../components/ui';
import { applyPageTitle, pageTitle, usePageTitle } from './page-title';

// MTR-134: unique tab titles per page, with the record ID on detail pages.

describe('pageTitle', () => {
  it.each([
    ['/', null, 'Dashboard · Material Mule'],
    ['/', 'Dashboard', 'Dashboard · Material Mule'],
    ['/receiving-log', 'Receiving Log', 'Receiving Log · Material Mule'],
    ['/receiving-log/new', null, 'Receive samples · Receiving Log · Material Mule'],
    [
      '/sample-storage/BKT-2026-000014',
      'BKT-2026-000014',
      'BKT-2026-000014 · Sample Storage · Material Mule',
    ],
    ['/sample-storage/move', null, 'Move storage units · Sample Storage · Material Mule'],
    ['/lab-testing', null, 'Worklist · Lab Testing · Material Mule'],
    ['/lab-testing/programs', null, 'Programs · Lab Testing · Material Mule'],
    ['/lab-testing/programs/p1', 'LP-2026-0001', 'LP-2026-0001 · Lab Testing · Material Mule'],
    ['/projects/p1', 'DEMO-2601', 'DEMO-2601 · Projects · Material Mule'],
    ['/projects/p1/team', null, 'Team & Permissions · Projects · Material Mule'],
    ['/settings/profile', null, 'My profile · Settings · Material Mule'],
    ['/settings/system-status', null, 'System status · Settings · Material Mule'],
    ['/action-requests', 'Action requests', 'Action requests · Material Mule'],
    ['/disposal-retention/scan', null, 'Disposal scan · Disposal & Retention · Material Mule'],
    ['/nowhere', 'Page not found', 'Page not found · Material Mule'],
  ])('%s (%s) → %s', (path, title, expected) => {
    expect(pageTitle(path, title)).toBe(expected);
  });

  it('gives each settings and lab tab its own title', () => {
    const paths = [
      '/settings/profile',
      '/settings/access',
      '/settings/staff',
      '/settings/locations',
      '/settings/tests',
      '/settings/templates',
      '/settings/printers',
      '/settings/receiving',
      '/settings/system-status',
      '/lab-testing',
      '/lab-testing/programs',
      '/lab-testing/programs/new',
    ];
    expect(new Set(paths.map((path) => pageTitle(path))).size).toBe(paths.length);
  });
});

function Detail({ id }: { id: string }) {
  usePageTitle(id);
  return <p>{id}</p>;
}

describe('usePageTitle', () => {
  it('names the page from its heading or record and follows navigation', async () => {
    const router = createMemoryRouter(
      [
        { path: '/projects', element: <PageHeader title="Projects" /> },
        { path: '/sample-storage/:id', element: <Detail id="BKT-2026-000014" /> },
        { path: '/settings/tests', element: <PageHeader title="Settings" documentTitle={false} /> },
      ],
      { initialEntries: ['/projects'] },
    );
    router.subscribe((state) => applyPageTitle(state.location.pathname));
    render(<RouterProvider router={router} />);
    expect(document.title).toBe('Projects · Material Mule');

    await act(() => router.navigate('/sample-storage/BKT-2026-000014'));
    expect(document.title).toBe('BKT-2026-000014 · Sample Storage · Material Mule');

    // A layout heading leaves the route's own label.
    await act(() => router.navigate('/settings/tests'));
    expect(document.title).toBe('Tests · Settings · Material Mule');
  });
});
