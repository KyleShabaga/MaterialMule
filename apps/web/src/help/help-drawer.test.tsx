import type { MeResponse } from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, Outlet, createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../session/context';
import { useOptionalFeedbackDialog } from '../feedback/feedback-context';
import { useOptionalHelpDrawer } from './help-drawer-context';
import { HelpDrawerSlot } from './help-drawer';
import { ShellOverlayProviders } from './shell-providers';

// The Help drawer (STRATA-103, round 10): ? or account menu › Help, beside the page. Fictional.

const ME: MeResponse = {
  id: '00000000-0000-4000-8000-0000000000a1',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-11-26T16:00:00.000Z',
};

function stubMatchMedia(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: wide && query.includes('min-width: 1024px'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

function HelpButton() {
  const help = useOptionalHelpDrawer()!;
  return (
    <button type="button" onClick={() => help.open()}>
      Open help
    </button>
  );
}

function FeedbackProbe() {
  const feedback = useOptionalFeedbackDialog();
  return feedback?.isOpen ? <p>feedback is open</p> : null;
}

function Shell() {
  return (
    <ShellOverlayProviders>
      <div data-slot="sidebar-inset">
        <header>Top bar</header>
        <main id="main" tabIndex={-1}>
          <HelpButton />
          <FeedbackProbe />
          <Outlet />
        </main>
        <HelpDrawerSlot />
      </div>
    </ShellOverlayProviders>
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          {
            path: '/sample-storage',
            element: (
              <div>
                <h1>Inventory</h1>
                <input aria-label="Notes" />
                <Link to="/receiving-log/new">Receive</Link>
              </div>
            ),
          },
          { path: '/receiving-log/new', element: <h1>Receive samples</h1> },
          { path: '/help', element: <h1>Help and how-tos</h1> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: ME },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return router;
}

const drawer = () => screen.queryByRole('complementary', { name: 'Help' });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Help drawer', () => {
  it('? opens help for this page beside it, the first task open; ? again closes it', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderAt('/sample-storage');
    await screen.findByRole('heading', { name: 'Inventory' });
    await user.keyboard('?');
    const help = await screen.findByRole('complementary', { name: 'Help' });
    // The page is still there, beside the drawer.
    expect(screen.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
    const heading = within(help).getByRole('heading', { level: 2, name: 'Help for Inventory' });
    expect(heading).toHaveFocus();
    expect(within(help).getByRole('button', { name: 'Find a unit' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(help).getByRole('button', { name: 'Move units' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Order: on this page, All guides with counts, Common questions.
    // (Accordion triggers sit in h3s too, so only the section headings are compared.)
    const sections = ['On this page', 'All guides', 'Common questions'];
    expect(
      within(help)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent)
        .filter((text) => sections.includes(text ?? '')),
    ).toEqual(sections);
    expect(within(help).getByRole('button', { name: /^Receiving, \d+$/ })).toBeInTheDocument();
    expect(within(help).getByText('Does an ID ever change?')).toBeInTheDocument();
    expect(within(help).getByRole('link', { name: 'Open as full page' })).toHaveAttribute(
      'href',
      '/help#find-unit',
    );
    expect(within(help).getByRole('separator', { name: 'Resize the help drawer' })).toHaveAttribute(
      'aria-valuenow',
      '46',
    );

    await user.keyboard('?');
    await waitFor(() => expect(drawer()).toBeNull());
  });

  it('never opens while typing in a field', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderAt('/sample-storage');
    await user.click(await screen.findByRole('textbox', { name: 'Notes' }));
    await user.keyboard('?');
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('?');
    expect(drawer()).toBeNull();
  });

  it('Esc closes it and focus goes back to the opener', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderAt('/sample-storage');
    await user.click(await screen.findByRole('button', { name: 'Open help' }));
    expect(await screen.findByRole('heading', { name: 'Help for Inventory' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(drawer()).toBeNull());
    expect(screen.getByRole('button', { name: 'Open help' })).toHaveFocus();
  });

  it('Close (Esc) in the toolbar closes it too', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderAt('/sample-storage');
    await user.click(await screen.findByRole('button', { name: 'Open help' }));
    const help = await screen.findByRole('complementary', { name: 'Help' });
    await user.click(within(help).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(drawer()).toBeNull());
  });

  it('searches, with a no-match state that offers Ask a question', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderAt('/sample-storage');
    await user.click(await screen.findByRole('button', { name: 'Open help' }));
    const help = await screen.findByRole('complementary', { name: 'Help' });
    await user.type(within(help).getByRole('searchbox', { name: 'Search help' }), 'label');
    expect(within(help).getByRole('heading', { level: 2, name: 'Search help' })).toBeVisible();
    expect(within(help).getByRole('status')).toHaveTextContent(/guides? match.*“label”/);
    await user.click(within(help).getByRole('button', { name: /Reprint a label/ }));
    // The guide opens in its group, with All help to go back.
    expect(
      within(help).getByRole('heading', { level: 2, name: 'Shelves, labels and retention' }),
    ).toHaveFocus();
    expect(within(help).getByRole('button', { name: 'Reprint a label' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await user.click(within(help).getByRole('button', { name: 'All help' }));

    await user.type(within(help).getByRole('searchbox', { name: 'Search help' }), 'invoice');
    expect(within(help).getByText('No guide matches “invoice”.')).toBeInTheDocument();
    await user.click(within(help).getByRole('button', { name: 'Ask a question' }));
    expect(await screen.findByText('feedback is open')).toBeInTheDocument();
  });

  it('Keyboard shortcuts is a sub-view with an All help back link', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderAt('/sample-storage');
    await user.click(await screen.findByRole('button', { name: 'Open help' }));
    const help = await screen.findByRole('complementary', { name: 'Help' });
    await user.click(within(help).getByRole('button', { name: /^Keyboard shortcuts, \d+$/ }));
    expect(
      within(help).getByRole('heading', { level: 2, name: 'Keyboard shortcuts' }),
    ).toHaveFocus();
    for (const what of [
      'Search or scan',
      'Collapse or expand the sidebar',
      'Open or close Help',
      'Close a drawer, menu or dialog',
      'Next and previous record in a drawer',
    ]) {
      expect(within(help).getByText(what)).toBeInTheDocument();
    }
    expect(within(help).getByRole('link', { name: 'Open as full page' })).toHaveAttribute(
      'href',
      '/help#keyboard-shortcuts',
    );
    await user.click(within(help).getByRole('button', { name: 'All help' }));
    expect(
      within(help).getByRole('heading', { level: 2, name: 'Help for Inventory' }),
    ).toBeVisible();
  });

  it('follows the page it is beside, and closes on /help', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    const router = renderAt('/sample-storage');
    await user.click(await screen.findByRole('button', { name: 'Open help' }));
    await screen.findByRole('heading', { name: 'Help for Inventory' });
    await user.click(screen.getByRole('link', { name: 'Receive' }));
    expect(await screen.findByRole('heading', { name: 'Help for Receive' })).toBeInTheDocument();
    await act(() => router.navigate('/help'));
    await waitFor(() => expect(drawer()).toBeNull());
  });

  it('resizes from the keyboard between 30 and 65 %', async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    renderAt('/sample-storage');
    await user.click(await screen.findByRole('button', { name: 'Open help' }));
    const handle = await screen.findByRole('separator', { name: 'Resize the help drawer' });
    handle.focus();
    await user.keyboard('{ArrowLeft}');
    expect(handle).toHaveAttribute('aria-valuenow', '48');
    await user.keyboard('{Home}');
    expect(handle).toHaveAttribute('aria-valuenow', '65');
    await user.keyboard('{End}');
    expect(handle).toHaveAttribute('aria-valuenow', '30');
    expect(handle.closest('[data-slot="sidebar-inset"]')!.getAttribute('style') ?? '').toContain(
      '--help-drawer-size: 30%',
    );
  });

  it('under 1024 px opens the Help page instead', async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    const router = renderAt('/sample-storage');
    await user.click(await screen.findByRole('button', { name: 'Open help' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/help'));
    expect(router.state.location.hash).toBe('#find-unit');
    expect(drawer()).toBeNull();
  });
});
