import type { MeResponse, ProjectSummary, TestHole } from '@materialmule/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { SessionProvider } from '../../session/SessionProvider';
import { newDraft, newSummary, type ReceiptDraft } from '../draft';
import { resetDraftCleanupForTests } from './cleanup-notice';
import { newRecord, type StoredDraft } from './record';
import { draftWritesSettled, indexedDbDraftStore as store } from './store';

// Review card (#113): a session that expires while a receipt draft is open, found by the window
// focus re-check (MTR-11), keeps the draft on screen with its saved-draft Sign in, instead of
// the route guard leaving at once. Real SessionProvider and router. Fictional data only.

const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000901',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  leadProjectEngineer: {
    id: '00000000-0000-4000-8000-000000000101',
    displayName: 'Pat Example',
    initials: 'PE',
  },
};
const th1: TestHole = {
  id: '00000000-0000-4000-8000-000000000911',
  projectId: project.id,
  name: 'TH26-01',
};

const account = (overrides: Partial<MeResponse>): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'project.create', 'test_hole.create', 'receipt.confirm'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});
const AT_ME = account({});
const PE_ME = account({
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Pat Example',
  initials: 'PE',
});
const LAB_ME = account({
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Who /api/me says is signed in; null is an expired session (401). */
const server = { me: null as MeResponse | null };

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/me')) {
        return server.me ? json(200, server.me) : json(401, { code: 'unauthenticated' });
      }
      if (!server.me) return json(401, { code: 'unauthenticated' });
      if (url.startsWith('/api/projects/search')) return json(200, [project]);
      if (url.startsWith(`/api/projects/${project.id}/test-holes`)) return json(200, [th1]);
      if (url.startsWith('/api/staff')) return json(200, []);
      return json(404, {});
    }),
  );
}

function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

function filled(): ReceiptDraft {
  const draft = newDraft(null, '2026-10-26');
  return {
    ...draft,
    project,
    description: 'Two buckets from the drill crew',
    units: [{ ...draft.units[0]!, summaries: [{ ...newSummary(th1), type: 'all' }] }],
  };
}

async function openDraft(owner: MeResponse): Promise<{ record: StoredDraft; path: string }> {
  const record = newRecord(filled(), owner);
  await store.put(record);
  return { record, path: `/receiving-log/new?draft=${record.draftId}` };
}

/** Closes the "tab": unmounts (which saves) and waits for storage. */
async function closeTab() {
  cleanup();
  await draftWritesSettled();
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetDraftCleanupForTests();
});

describe('Receiving draft when the session expires in the background', () => {
  it('stays on the LAB draft with Sign in after a focus re-check, then signs in back to it', async () => {
    const user = userEvent.setup();
    server.me = LAB_ME;
    stubApi();
    const { record, path } = await openDraft(LAB_ME);
    const router = renderApp(path);
    const description = await screen.findByLabelText('Description (optional)');
    expect(description).toHaveValue('Two buckets from the drill crew');
    await user.type(description, ', lids taped');

    server.me = null;
    fireEvent.focus(window);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The LAB session has expired. Your draft is saved. Sign in to confirm.',
    );
    // Still on the draft, with the latest edit.
    expect(router.state.location.pathname).toBe('/receiving-log/new');
    expect(screen.getByLabelText('Description (optional)')).toHaveValue(
      'Two buckets from the drill crew, lids taped',
    );

    await user.click(within(alert).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('returnTo')).toBe(path);
    expect(params.get('expired')).toBe('1');
    expect(screen.getByText(/The LAB session has expired/)).toBeInTheDocument();
    await closeTab();
    expect(await store.get(record.draftId)).toMatchObject({
      status: 'editing',
      data: { description: 'Two buckets from the drill crew, lids taped' },
    });

    // Signing in again (a fresh page load from Microsoft) comes back to the same draft.
    server.me = LAB_ME;
    renderApp(params.get('returnTo')!);
    expect(await screen.findByLabelText('Description (optional)')).toHaveValue(
      'Two buckets from the drill crew, lids taped',
    );
  });

  it('a different person signing in after the expiry does not get the draft', async () => {
    const user = userEvent.setup();
    server.me = AT_ME;
    stubApi();
    const { record, path } = await openDraft(AT_ME);
    const router = renderApp(path);
    expect(await screen.findByLabelText('Description (optional)')).toHaveValue(
      'Two buckets from the drill crew',
    );

    server.me = null;
    fireEvent.focus(window);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your session has expired. Your draft is saved.');
    await user.click(within(alert).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    const returnTo = new URLSearchParams(router.state.location.search).get('returnTo')!;
    await closeTab();

    server.me = PE_ME;
    renderApp(returnTo);
    // PE starts a new, empty receipt; AT's draft stays on this computer for AT only.
    expect(await screen.findByRole('combobox', { name: /Find project/ })).toHaveValue('');
    expect(screen.queryByText('Drafts on this computer')).toBeNull();
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('');
    expect(await store.get(record.draftId)).toMatchObject({ owner: { accountId: AT_ME.id } });
  });

  it('a different account found by the focus re-check never sees the open draft', async () => {
    server.me = AT_ME;
    stubApi();
    const { path } = await openDraft(AT_ME);
    renderApp(path);
    expect(await screen.findByLabelText('Description (optional)')).toHaveValue(
      'Two buckets from the drill crew',
    );

    // PE signed in from another tab on this browser.
    server.me = PE_ME;
    fireEvent.focus(window);
    await waitFor(() =>
      expect(screen.getByLabelText('Signed in user')).toHaveTextContent('Pat Example'),
    );
    expect(screen.queryByDisplayValue('Two buckets from the drill crew')).toBeNull();
  });
});
