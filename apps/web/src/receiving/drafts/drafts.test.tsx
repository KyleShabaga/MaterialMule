import type { MeResponse, ProjectSummary, ReceiverOption, TestHole } from '@trapezoid/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';
import { newDraft, newSummary, type ReceiptDraft } from '../draft';
import { newRecord, type StoredDraft } from './record';
import { draftWritesSettled, indexedDbDraftStore as store } from './store';

// Receiving drafts in the browser (TRP-T11), against fake-indexeddb. Fictional data only.

const AT: ReceiverOption = {
  id: '00000000-0000-4000-8000-000000000102',
  initials: 'AT',
  displayName: 'Alex Tester',
  position: null,
};
const PE: ReceiverOption = {
  id: '00000000-0000-4000-8000-000000000101',
  initials: 'PE',
  displayName: 'Pat Example',
  position: null,
};
const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000901',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  pmPe: { id: PE.id, displayName: PE.displayName, initials: PE.initials },
};
const th1: TestHole = {
  id: '00000000-0000-4000-8000-000000000911',
  projectId: project.id,
  name: 'TH26-01',
};

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: AT.id,
  displayName: AT.displayName,
  initials: AT.initials,
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'project.create', 'test_hole.create', 'receipt.confirm'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  position: null,
  positionSetupRequired: false,
  profileRefreshFailed: false,
  ...overrides,
});
const LAB_ME = me({
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
});
const PE_ME = me({ id: PE.id, displayName: PE.displayName, initials: PE.initials });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (body: unknown) => Response | Promise<Response>;

function renderPage(
  session: MeResponse,
  extra: Record<string, Handler> = {},
  path = '/receiving-log/new',
) {
  const api: Record<string, Handler> = {
    'GET /api/projects/search': () => json(200, [project]),
    [`GET /api/projects/${project.id}/test-holes`]: () => json(200, [th1]),
    'GET /api/staff/receivers': () => json(200, [PE]),
    'GET /api/staff/active': () => json(200, [AT, PE]),
    ...extra,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const key = Object.keys(api).find((k) => {
        const [m, prefix] = k.split(' ');
        return m === method && url.startsWith(prefix!);
      });
      if (key) return api[key]!(init?.body ? JSON.parse(String(init.body)) : undefined);
      return json(404, {});
    }),
  );
  const refresh = vi.fn(async () => undefined);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh,
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return { router, refresh };
}

/** Closes the "tab": unmounts (which saves) and waits for storage. */
async function closeTab() {
  cleanup();
  await draftWritesSettled();
}

/** A filled draft: DEMO-2601, one bucket with TH26-01 ALL. */
function filled(receiver: ReceiverOption | null): ReceiptDraft {
  const draft = newDraft(receiver, '2026-10-26');
  return {
    ...draft,
    project,
    description: 'Two buckets from the drill crew',
    units: [{ ...draft.units[0]!, summaries: [{ ...newSummary(th1), type: 'all' }] }],
  };
}

async function stored(record: StoredDraft) {
  await store.put(record);
  return record;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Receiving drafts (TRP-T11)', () => {
  it('AC1: edits autosave; reopening lists the draft and resumes it with every field intact', async () => {
    const user = userEvent.setup();
    renderPage(me());
    expect(await screen.findByText(/Draft not saved yet · Receiver: AT/)).toBeInTheDocument();
    await user.type(await screen.findByRole('combobox', { name: /Find project/ }), 'river');
    await user.click(await screen.findByRole('option', { name: /DEMO-2601/ }));
    await user.type(screen.getByLabelText('Description (optional)'), 'Two buckets');
    const bucket = screen.getByRole('region', { name: 'Bucket 1' });
    await user.type(within(bucket).getByLabelText('Bucket 1 note (optional)'), 'Lid taped');
    // Saved about 1 s after the last change, with the time and receiver shown.
    expect(await screen.findByText(/Draft saved/, {}, { timeout: 3000 })).toHaveTextContent(
      /^Draft saved \d{2}:\d{2} · Receiver: AT$/,
    );

    await closeTab();
    renderPage(me());
    const list = await screen.findByRole('region', { name: 'Drafts on this computer' });
    expect(within(list).getByRole('heading', { name: 'DEMO-2601 · Riverbank investigation' }));
    expect(within(list).getByText(/1 storage unit · Receiver: AT · Last saved/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start new receipt' })).toBeVisible();

    await user.click(within(list).getByRole('button', { name: /Resume draft DEMO-2601/ }));
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('Two buckets');
    expect(screen.getByLabelText('Project number')).toHaveValue('DEMO-2601');
    expect(screen.getByLabelText('Bucket 1 note (optional)')).toHaveValue('Lid taped');
    expect(screen.getByRole('combobox', { name: 'Received by' })).toHaveValue('AT · Alex Tester');
    expect(screen.getByText(/Draft saved/)).toHaveTextContent(
      /^Draft saved \d{2}:\d{2} · Receiver: AT$/,
    );
  });

  it('a new receipt that was never changed leaves no draft behind', async () => {
    renderPage(me());
    await screen.findByRole('combobox', { name: /Find project/ });
    await closeTab();
    expect((await store.list()).drafts).toEqual([]);
  });

  it('AC3: a failed write says the draft could not be saved, never "saved"', async () => {
    const user = userEvent.setup();
    vi.spyOn(store, 'put').mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    renderPage(me());
    await user.type(await screen.findByLabelText('Description (optional)'), 'Two buckets');
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert).toHaveTextContent("Couldn't save draft on this device · Receiver: AT");
    expect(alert).toHaveTextContent('This computer has no storage space left for drafts.');
    expect(screen.queryByText(/Draft saved/)).toBeNull();
  });

  it('AC4: a resumed LAB draft keeps its receiver until someone explicitly picks another', async () => {
    const user = userEvent.setup();
    const record = await stored(newRecord(filled(AT), LAB_ME));
    renderPage(LAB_ME, {}, `/receiving-log/new?draft=${record.draftId}`);

    const banner = await screen.findByRole('region', {
      name: 'This draft was started for AT. Change receiver?',
    });
    expect(screen.getByRole('combobox', { name: 'Received by' })).toHaveValue('AT · Alex Tester');
    // Nothing changes on its own: still AT in storage, no history entry.
    await draftWritesSettled();
    expect((await store.get(record.draftId))?.history).toHaveLength(1);

    await user.type(within(banner).getByRole('combobox', { name: 'Change receiver to' }), 'PE');
    await user.click(await within(banner).findByRole('option', { name: /PE · Pat Example/ }));
    expect(screen.getByRole('combobox', { name: 'Received by' })).toHaveValue('PE · Pat Example');
    expect(screen.getByText(/Receiver changed to PE/)).toBeInTheDocument();

    await closeTab();
    const saved = await store.get(record.draftId);
    expect(saved?.receiver?.initials).toBe('PE');
    expect(saved?.history.at(-1)).toMatchObject({
      type: 'receiver_changed',
      accountId: LAB_ME.id,
      from: { initials: 'AT' },
      to: { initials: 'PE' },
    });
  });

  it('AC4: "Keep" dismisses the question without changing anything', async () => {
    const user = userEvent.setup();
    const record = await stored(newRecord(filled(AT), LAB_ME));
    renderPage(LAB_ME, {}, `/receiving-log/new?draft=${record.draftId}`);
    await user.click(await screen.findByRole('button', { name: 'Keep AT' }));
    expect(screen.queryByText(/This draft was started for AT/)).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Received by' })).toHaveValue('AT · Alex Tester');
  });

  it('AC7: personal drafts are listed only for their owner; LAB drafts only for LAB', async () => {
    await stored(newRecord(filled(AT), me()));
    await stored(newRecord(filled(null), LAB_ME));

    renderPage(PE_ME);
    // Nothing to show PE: straight into a new receipt.
    expect(await screen.findByRole('combobox', { name: /Find project/ })).toHaveValue('');
    expect(screen.queryByText('Drafts on this computer')).toBeNull();
    await closeTab();

    renderPage(me());
    const mine = await screen.findByRole('region', { name: 'Drafts on this computer' });
    expect(within(mine).getAllByRole('listitem')).toHaveLength(1);
    expect(within(mine).getByText(/Receiver: AT/)).toBeInTheDocument();
    await closeTab();

    renderPage(LAB_ME);
    const lab = await screen.findByRole('region', { name: 'Drafts on this computer' });
    expect(within(lab).getAllByRole('listitem')).toHaveLength(1);
    expect(within(lab).getByText(/Receiver: not chosen/)).toBeInTheDocument();
  });

  it('AC5: an expired session keeps the user on the draft and offers Sign in', async () => {
    const user = userEvent.setup();
    const record = await stored({ ...newRecord(filled(AT), me()), step: 'review' });
    const { refresh } = renderPage(
      me(),
      { 'POST /api/receipts': () => json(401, { code: 'unauthenticated' }) },
      `/receiving-log/new?draft=${record.draftId}`,
    );
    await user.click(await screen.findByRole('button', { name: 'Confirm receipt' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Your session has expired. Your draft is saved. Sign in to confirm.',
    );
    // Still on the draft.
    expect(screen.getByText('Two buckets from the drill crew')).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Sign in' }));
    expect(refresh).toHaveBeenCalled();
    await closeTab();
    expect(await store.get(record.draftId)).toMatchObject({ status: 'editing', step: 'review' });
  });

  it('AC6: a draft left "confirming" resends with the same key on resume, then is deleted', async () => {
    const user = userEvent.setup();
    const record = await stored({
      ...newRecord(filled(AT), me()),
      step: 'review',
      status: 'confirming',
    });
    const posts: { idempotencyKey: string; units: { clientRowId: string }[] }[] = [];
    renderPage(me(), {
      'POST /api/receipts': (body) => {
        const sent = body as (typeof posts)[number];
        posts.push(sent);
        return json(200, {
          receiptId: '00000000-0000-4000-8000-000000000980',
          units: sent.units.map((u) => ({
            clientRowId: u.clientRowId,
            storageUnitId: '00000000-0000-4000-8000-000000000990',
            suNumber: 'BKT-2026-000042',
          })),
        });
      },
    });
    const list = await screen.findByRole('region', { name: 'Drafts on this computer' });
    expect(within(list).getByText('Confirmation interrupted')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: /Resume draft/ }));
    expect(await screen.findByRole('heading', { name: 'BKT-2026-000042' })).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.idempotencyKey).toBe(record.idempotencyKey);
    await draftWritesSettled();
    expect(await store.get(record.draftId)).toBeNull();
  });

  it('Discard asks first, then removes the draft from this computer', async () => {
    const user = userEvent.setup();
    await stored(newRecord(filled(AT), me()));
    renderPage(me());
    const list = await screen.findByRole('region', { name: 'Drafts on this computer' });
    await user.click(within(list).getByRole('button', { name: /Discard draft DEMO-2601/ }));
    expect((await store.list()).drafts).toHaveLength(1);
    // The native <dialog> isn't opened by jsdom, so its buttons count as hidden.
    await user.click(screen.getByRole('button', { name: 'Discard draft', hidden: true }));
    expect(await screen.findByText('No drafts on this computer.')).toBeInTheDocument();
    expect((await store.list()).drafts).toHaveLength(0);
  });
});

describe('Draft auto-delete on Receive samples (MM-T45)', () => {
  const DAY = 86_400_000;
  const savedDaysAgo = (record: StoredDraft, days: number): StoredDraft => {
    const at = new Date(Date.now() - days * DAY).toISOString();
    return { ...record, createdAt: at, lastSavedAt: at };
  };
  const setting = (enabled: boolean, afterDays = 90) => ({
    'GET /api/settings/drafts': () =>
      json(200, { draftAutoDelete: { enabled, afterDays }, version: 2 }),
  });

  it('AC1: with the setting off, old drafts stay and show the T11 Stale badge', async () => {
    const old = await stored(savedDaysAgo(newRecord(filled(AT), me()), 400));
    renderPage(me(), setting(false));
    const list = await screen.findByRole('region', { name: 'Drafts on this computer' });
    expect(within(list).getByText('Stale').parentElement).toHaveTextContent(
      'Stale Not saved for over 30 days. Review it, then confirm or discard it.',
    );
    expect(within(list).queryByRole('status')).toBeNull();
    expect(await store.get(old.draftId)).not.toBeNull();
  });

  it('AC2/AC3: deletes drafts older than the setting, keeps confirming ones, and says how many', async () => {
    const old = await stored(savedDaysAgo(newRecord(filled(AT), me()), 120));
    const older = await stored(savedDaysAgo(newRecord(filled(null), me()), 300));
    const stale = await stored(savedDaysAgo(newRecord(filled(AT), me()), 45));
    const confirming = await stored({
      ...savedDaysAgo(newRecord(filled(AT), me()), 200),
      step: 'review',
      status: 'confirming',
    });
    // Someone else's old draft on the same browser isn't this session's to delete.
    const others = await stored(savedDaysAgo(newRecord(filled(PE), PE_ME), 300));
    renderPage(me(), setting(true, 90));

    const list = await screen.findByRole('region', { name: 'Drafts on this computer' });
    expect(within(list).getByRole('status')).toHaveTextContent(
      '2 drafts older than 90 days were deleted from this computer (automatic clean-up set by an administrator).',
    );
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(await store.get(old.draftId)).toBeNull();
    expect(await store.get(older.draftId)).toBeNull();
    expect(await store.get(stale.draftId)).not.toBeNull();
    expect(await store.get(confirming.draftId)).not.toBeNull();
    expect(await store.get(others.draftId)).not.toBeNull();

    const [first, second] = within(list).getAllByRole('listitem');
    // Newest first: the 45-day draft says when it goes; the confirming one keeps T11 wording.
    expect(within(first!).getByText('Stale').parentElement).toHaveTextContent(
      'Not saved for over 30 days. Deleted automatically after 90 days without changes. Review it, then confirm or discard it.',
    );
    expect(within(second!).getByText('Confirmation interrupted')).toBeInTheDocument();
    expect(within(second!).getByText('Stale').parentElement).toHaveTextContent(
      'Stale Not saved for over 30 days. Review it, then confirm or discard it.',
    );
  });

  it('stays on the list to show the notice when every draft was deleted', async () => {
    await stored(savedDaysAgo(newRecord(filled(AT), me()), 120));
    renderPage(me(), setting(true, 90));
    const list = await screen.findByRole('region', { name: 'Drafts on this computer' });
    expect(within(list).getByRole('status')).toHaveTextContent(
      '1 draft older than 90 days was deleted from this computer',
    );
    expect(within(list).getByText('No drafts on this computer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start new receipt' })).toBeVisible();
  });

  it('AC7: deletes nothing when the setting cannot be loaded', async () => {
    const old = await stored(savedDaysAgo(newRecord(filled(AT), me()), 400));
    renderPage(me(), { 'GET /api/settings/drafts': () => json(500, {}) });
    const list = await screen.findByRole('region', { name: 'Drafts on this computer' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).queryByRole('status')).toBeNull();
    expect(await store.get(old.draftId)).not.toBeNull();
    await closeTab();

    renderPage(me(), {
      'GET /api/settings/drafts': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await screen.findByRole('region', { name: 'Drafts on this computer' });
    expect(await store.get(old.draftId)).not.toBeNull();
  });
});
