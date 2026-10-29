import type { MeResponse, ProjectSummary, TestHole } from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// Receiving wizard (MM-T10). Every project, person and hole here is fictional.

const PE = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Pat Example',
  initials: 'PE',
};
const AT = {
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
};
const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000901',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  pmPe: PE,
};
const th1: TestHole = {
  id: '00000000-0000-4000-8000-000000000911',
  projectId: project.id,
  name: 'TH26-01',
};
const th2: TestHole = {
  id: '00000000-0000-4000-8000-000000000912',
  projectId: project.id,
  name: 'TH26-02',
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (body: unknown) => Response | Promise<Response>;

function renderWizard(extra: Record<string, Handler> = {}, session = me()) {
  const api: Record<string, Handler> = {
    'GET /api/projects/search': () => json(200, [project]),
    [`GET /api/projects/${project.id}/test-holes`]: () => json(200, [th1, th2]),
    ...extra,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = Object.keys(api)
      .filter((k) => {
        const [m, prefix] = k.split(' ');
        return m === method && url.startsWith(prefix!);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (key) return api[key]!(init?.body ? JSON.parse(String(init.body)) : undefined);
    if (url.startsWith('/api/staff/active')) return json(200, [AT, PE]);
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: ['/receiving-log/new'] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setOnline(true);
});

type User = ReturnType<typeof userEvent.setup>;

async function chooseProject(user: User) {
  await user.type(await screen.findByRole('combobox', { name: /Find project/ }), 'river');
  await user.click(await screen.findByRole('option', { name: /DEMO-2601/ }));
}

async function addHole(user: User, unit: HTMLElement, name: string) {
  await user.type(within(unit).getByRole('combobox', { name: 'Find or add a test hole' }), name);
  await user.click(await within(unit).findByRole('option', { name }));
}

function holeGroup(unit: HTMLElement, hole: string) {
  return within(within(unit).getByRole('group', { name: `${hole} summary` }));
}

async function sampleRange(user: User, unit: HTMLElement, hole: string, from: string, to: string) {
  const group = holeGroup(unit, hole);
  await user.selectOptions(group.getByLabelText('Summary type'), 'sample_range');
  await user.type(group.getByLabelText('Sample from'), from);
  await user.type(group.getByLabelText('Sample to'), to);
}

const bucket = (n: number) => screen.getByRole('region', { name: `Bucket ${n}` });

function issued(body: unknown, first = 1) {
  const units = (body as { units: { clientRowId: string }[] }).units;
  return {
    receiptId: '00000000-0000-4000-8000-000000000980',
    units: units.map((u, i) => ({
      clientRowId: u.clientRowId,
      storageUnitId: `00000000-0000-4000-8000-00000000099${i}`,
      suNumber: `BKT-2026-00000${i + first}`,
    })),
  };
}

describe('Receiving wizard layout (MM-T55 part C)', () => {
  it('shows the step tag and chips, banded cards, and the bottom action bar per step', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);

    expect(screen.getByRole('heading', { level: 1, name: 'Receive samples' })).toBeVisible();
    expect(screen.getByText('Step 1 of 3')).toBeVisible();
    const steps = screen.getByRole('list', { name: 'Receiving steps' });
    expect(within(steps).getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('region', { name: 'Details' })).toBeVisible();
    const unit = bucket(1);
    expect(within(unit).getByRole('heading', { level: 3, name: 'Bucket 1' })).toBeVisible();
    expect(within(unit).getByText('no test holes yet')).toBeVisible();

    // Step 1 bar: no problems yet, the draft status, Discard draft and Next: Review.
    const bar = () => document.querySelector<HTMLElement>('.wizard-step > .wizard-actions')!;
    expect(within(bar()).queryByText(/problems? to fix/)).toBeNull();
    expect(within(bar()).getByText(/Receiver: AT/)).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Discard draft' })).toBeVisible();

    // Trying to move on with a bucket that has no test hole counts the problems in the bar.
    await user.click(within(bar()).getByRole('button', { name: 'Next: Review' }));
    expect(within(bar()).getByText(/^\d+ problems? to fix$/)).toBeVisible();

    await addHole(user, bucket(1), 'TH26-01');
    await sampleRange(user, bucket(1), 'TH26-01', 'G1', 'S12');
    await user.click(within(bar()).getByRole('button', { name: 'Next: Review' }));
    expect(await screen.findByText('Step 2 of 3')).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Back' })).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Confirm receipt' })).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Discard draft' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Bucket 1' })).toBeVisible();
  });
});

describe('Receiving wizard (MM-T10)', () => {
  it('AC1/AC2: two buckets, one with a mixed-hole summary, confirmed in one request', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    renderWizard({
      'POST /api/receipts': (body) => {
        posts.push(body);
        return json(201, issued(body));
      },
    });
    await chooseProject(user);
    expect(screen.getAllByText('1 storage unit').length).toBeGreaterThan(0);

    await addHole(user, bucket(1), 'TH26-01');
    await sampleRange(user, bucket(1), 'TH26-01', 'G1', 'S12');
    await addHole(user, bucket(1), 'TH26-02');
    await user.selectOptions(holeGroup(bucket(1), 'TH26-02').getByLabelText('Summary type'), 'all');
    expect(within(bucket(1)).getByText('TH26-01: G1–S12 · TH26-02: ALL')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Add bucket' }));
    expect(screen.getAllByText('2 storage units').length).toBeGreaterThan(0);
    await addHole(user, bucket(2), 'TH26-01');
    await sampleRange(user, bucket(2), 'TH26-01', 'G13', 'S32');

    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    const review1 = await screen.findByRole('region', { name: 'Bucket 1' });
    expect(within(review1).getByText('G1–S12')).toBeInTheDocument();
    expect(within(review1).getByText('ALL')).toBeInTheDocument();
    expect(within(bucket(2)).getByText('G13–S32')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument(); // blank description (AC8)
    expect(screen.getByText('2 storage units')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm receipt' }));
    expect(await screen.findByRole('heading', { name: 'BKT-2026-000001' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'BKT-2026-000002' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print all labels' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Print BKT-2026-000001' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Open BKT-2026-000002' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000002',
    );

    expect(posts).toHaveLength(1);
    const sent = posts[0] as {
      idempotencyKey: string;
      description: string;
      units: { unitType: string; holeSummaries: unknown[] }[];
    };
    expect(sent.description).toBe('');
    expect(sent.units.map((u) => u.unitType)).toEqual(['bucket', 'bucket']);
    expect(sent.units[0]!.holeSummaries).toEqual([
      { testHoleId: th1.id, type: 'sample_range', note: '', sampleFrom: 'G1', sampleTo: 'S12' },
      { testHoleId: th2.id, type: 'all', note: '' },
    ]);

    // Receive another starts a new draft with a new idempotency key.
    await user.click(screen.getByRole('button', { name: 'Receive another' }));
    expect(screen.getByRole('combobox', { name: /Find project/ })).toHaveValue('');
    expect(screen.getAllByText('1 storage unit').length).toBeGreaterThan(0);
    expect(screen.getByRole('combobox', { name: 'Received by' })).toHaveValue('AT · Alex Tester');
  });

  it('AC3: a reversed depth range and a missing ft/m block Next with a linked error summary', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    const group = holeGroup(bucket(1), 'TH26-01');
    await user.selectOptions(group.getByLabelText('Summary type'), 'depth_range');
    await user.type(group.getByLabelText('Depth from'), '30');
    await user.type(group.getByLabelText('Depth to'), '0');
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));

    const summary = screen.getByRole('alert');
    expect(summary).toHaveFocus();
    expect(
      within(summary).getByRole('link', {
        name: 'Bucket 1 · TH26-01: Depth to must be greater than or equal to depth from.',
      }),
    ).toBeInTheDocument();
    expect(
      within(summary).getByRole('link', { name: 'Bucket 1 · TH26-01: Choose ft or m.' }),
    ).toBeInTheDocument();
    expect(group.getByLabelText('Depth to')).toHaveAttribute('aria-invalid', 'true');
    expect(group.getByRole('radiogroup', { name: 'Depth unit' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next: Review' })).toBeInTheDocument();

    await user.click(within(summary).getByRole('link', { name: /Depth to must be/ }));
    expect(group.getByLabelText('Depth to')).toHaveFocus();

    // Fixing both moves on; 10.5 m stays 10.5 m (AC4).
    await user.clear(group.getByLabelText('Depth from'));
    await user.type(group.getByLabelText('Depth from'), '0');
    await user.clear(group.getByLabelText('Depth to'));
    await user.type(group.getByLabelText('Depth to'), '10.5');
    await user.click(group.getByRole('radio', { name: 'm' }));
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    expect(await screen.findByText('0–10.5 m')).toBeInTheDocument();
  });

  it('AC3: empty Custom text and a unit without a test hole are reported', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await user.selectOptions(
      holeGroup(bucket(1), 'TH26-01').getByLabelText('Summary type'),
      'custom',
    );
    expect(screen.getByText('State units if you describe depths.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add bucket' }));
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    const summary = screen.getByRole('alert');
    expect(
      within(summary)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Bucket 1 · TH26-01: Describe the samples (Custom needs text).',
      'Bucket 2: Choose at least one test hole.',
    ]);
  });

  it('AC6/AC7: offline disables Confirm with the message; Review → Back → Review keeps everything', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await user.type(screen.getByLabelText('Description (optional)'), 'Two buckets');
    await addHole(user, bucket(1), 'TH26-01');
    const group = holeGroup(bucket(1), 'TH26-01');
    await user.selectOptions(group.getByLabelText('Summary type'), 'custom');
    await user.type(group.getByLabelText('Custom summary'), 'Grab samples, 0–2 m');
    await user.type(within(bucket(1)).getByLabelText('Bucket 1 note (optional)'), 'Lid cracked');
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));

    setOnline(false);
    expect(
      screen.getByText("You're offline. Your draft is kept. Connect to confirm."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm receipt' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('Two buckets');
    expect(holeGroup(bucket(1), 'TH26-01').getByLabelText('Custom summary')).toHaveValue(
      'Grab samples, 0–2 m',
    );
    expect(within(bucket(1)).getByLabelText('Bucket 1 note (optional)')).toHaveValue('Lid cracked');
    expect(screen.getByLabelText('Project name')).toHaveValue('Riverbank investigation');
    expect(screen.getByRole('combobox', { name: 'Received by' })).toHaveValue('AT · Alex Tester');

    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    expect(screen.getByText('Grab samples, 0–2 m')).toBeInTheDocument();
    setOnline(true);
    expect(screen.getByRole('button', { name: 'Confirm receipt' })).toBeEnabled();

    // Edit on a unit returns to that unit on step 1.
    await user.click(screen.getByRole('button', { name: 'Edit Bucket 1' }));
    expect(screen.getByRole('heading', { name: 'Bucket 1' })).toHaveFocus();
  });

  it('retries a lost response automatically with the same idempotency key and body', async () => {
    const user = userEvent.setup();
    const bodies: string[] = [];
    renderWizard({
      'POST /api/receipts': (body) => {
        bodies.push(JSON.stringify(body));
        if (bodies.length === 1) throw new TypeError('Failed to fetch');
        return json(200, issued(body, 7));
      },
    });
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await user.selectOptions(holeGroup(bucket(1), 'TH26-01').getByLabelText('Summary type'), 'all');
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    await user.click(screen.getByRole('button', { name: 'Confirm receipt' }));
    expect(screen.getByRole('button', { name: /Confirming/ })).toBeDisabled();
    expect(
      await screen.findByRole('heading', { name: 'BKT-2026-000007' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('server field errors return to step 1 next to the field', async () => {
    const user = userEvent.setup();
    renderWizard({
      'POST /api/receipts': () =>
        json(400, {
          code: 'validation_failed',
          errors: [
            {
              field: 'receiverUserId',
              code: 'receiver_not_active',
              message: 'must be an active staff member',
            },
          ],
        }),
    });
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await user.selectOptions(holeGroup(bucket(1), 'TH26-01').getByLabelText('Summary type'), 'all');
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    await user.click(screen.getByRole('button', { name: 'Confirm receipt' }));
    const summary = await screen.findByRole('alert');
    expect(
      within(summary).getByRole('link', { name: 'Received by must be an active staff member.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Received by' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('Enter in a unit field never submits; Alt+N adds a unit; duplicate and remove', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await addHole(user, bucket(1), 'TH26-01');
    await sampleRange(user, bucket(1), 'TH26-01', 'G1', 'S4');
    await user.type(within(bucket(1)).getByLabelText('Bucket 1 note (optional)'), 'Heavy{Enter}');
    expect(screen.getByRole('button', { name: 'Next: Review' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();

    await user.keyboard('{Alt>}n{/Alt}');
    // MM-T66 UI-05: the new bucket's test hole search has focus.
    expect(
      within(bucket(2)).getByRole('combobox', { name: 'Find or add a test hole' }),
    ).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Duplicate Bucket 1' }));
    expect(screen.getAllByText('3 storage units').length).toBeGreaterThan(0);
    expect(within(bucket(2)).getByText('TH26-01: G1–S4')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Bucket 3' }));
    expect(screen.getAllByText('2 storage units').length).toBeGreaterThan(0);
  });

  describe('MM-T66 UI-08/UI-11: Review receipt above 1280px', () => {
    /** matchMedia that answers `wide` for exactly the "> 1280px" query and records the queries. */
    function stubWidth(wide: boolean) {
      const queries: string[] = [];
      vi.stubGlobal('matchMedia', (query: string) => {
        queries.push(query);
        return {
          matches: wide && query === '(width > 1280px)',
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
      });
      return queries;
    }

    async function toReview(user: User) {
      await chooseProject(user);
      await addHole(user, bucket(1), 'TH26-01');
      await sampleRange(user, bucket(1), 'TH26-01', 'G1', 'S4');
      await addHole(user, bucket(1), 'TH26-02');
      await user.selectOptions(
        holeGroup(bucket(1), 'TH26-02').getByLabelText('Summary type'),
        'all',
      );
      await user.click(screen.getByRole('button', { name: 'Add bucket' }));
      await addHole(user, bucket(2), 'TH26-01');
      await user.selectOptions(
        holeGroup(bucket(2), 'TH26-01').getByLabelText('Summary type'),
        'all',
      );
      await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    }

    it('shows one table with shared headers, a row per unit, every summary and Edit', async () => {
      const queries = stubWidth(true);
      const user = userEvent.setup();
      renderWizard();
      await toReview(user);

      const table = await screen.findByRole('table', { name: 'Storage units in this receipt' });
      expect(queries).toContain('(width > 1280px)');
      expect(
        within(table)
          .getAllByRole('columnheader')
          .map((th) => th.textContent),
      ).toEqual(['Storage unit', 'Type', 'Sampling source (SAMPLE#/DEPTH)', 'Note', 'Actions']);
      const [, first, second] = within(table).getAllByRole('row');
      expect(within(first!).getByRole('rowheader')).toHaveTextContent('Bucket 1');
      expect(first).toHaveTextContent('TH26-01 G1–S4');
      expect(first).toHaveTextContent('TH26-02 ALL');
      expect(within(second!).getByRole('rowheader')).toHaveTextContent('Bucket 2');
      // No separate card per unit at this width.
      expect(screen.queryByRole('region', { name: 'Bucket 1' })).toBeNull();
      // UI-11: the Details summary keeps every field and its action.
      const details = screen.getByRole('region', { name: 'Details' });
      for (const term of ['Project', 'Received date', 'Received by', 'Description', 'Quantity']) {
        expect(within(details).getByText(term)).toBeInTheDocument();
      }
      expect(within(details).getByRole('button', { name: 'Edit details' })).toBeEnabled();

      await user.click(within(table).getByRole('button', { name: 'Edit Bucket 2' }));
      // Focus moves to the unit's heading once it renders. Query inside waitFor so a re-rendered
      // heading is found again (MM-T71: this was flaky on busy CI).
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Bucket 2' })).toHaveFocus());
    });

    it('keeps a card per unit at 1280px and below', async () => {
      stubWidth(false);
      const user = userEvent.setup();
      renderWizard();
      await toReview(user);
      expect(await screen.findByRole('region', { name: 'Bucket 1' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Bucket 2' })).toBeInTheDocument();
      expect(screen.queryByRole('table', { name: 'Storage units in this receipt' })).toBeNull();
    });
  });

  describe('MM-T66 UI-05/UI-06: keyboard flow for test holes', () => {
    const search = (unit: HTMLElement) =>
      within(unit).getByRole('combobox', { name: 'Find or add a test hole' });

    it('Alt+N adds one bucket and typing goes straight into its test hole search', async () => {
      const user = userEvent.setup();
      renderWizard();
      await chooseProject(user);
      await user.click(within(bucket(1)).getByLabelText('Bucket 1 note (optional)'));
      await user.keyboard('{Alt>}n{/Alt}');
      expect(screen.getAllByRole('region', { name: /^Bucket \d$/ })).toHaveLength(2);
      expect(search(bucket(2))).toHaveFocus();
      expect(search(bucket(1))).not.toHaveFocus();
      await user.keyboard('TH26-02');
      expect(search(bucket(2))).toHaveValue('TH26-02');
      expect(search(bucket(1))).toHaveValue('');
      await user.keyboard('{Enter}');
      expect(
        within(bucket(2)).getByRole('list', { name: 'Selected test holes' }),
      ).toHaveTextContent('TH26-02');
    });

    it('Alt+N still works after Enter has left the test hole search', async () => {
      const user = userEvent.setup();
      renderWizard();
      await chooseProject(user);
      await user.type(search(bucket(1)), 'TH26-01');
      await within(bucket(1)).findByRole('option', { name: 'TH26-01' });
      await user.keyboard('{Enter}');
      expect(document.activeElement).toBe(document.body);
      await user.keyboard('{Alt>}n{/Alt}');
      expect(search(bucket(2))).toHaveFocus();
    });

    it('Alt+N before a project is chosen focuses the new bucket heading', async () => {
      const user = userEvent.setup();
      renderWizard();
      await user.click(await screen.findByLabelText('Description (optional)'));
      await user.keyboard('{Alt>}n{/Alt}');
      expect(screen.getByRole('heading', { name: 'Bucket 2' })).toHaveFocus();
    });

    it('Enter on an existing hole selects it, closes the list and leaves the search box', async () => {
      const user = userEvent.setup();
      renderWizard();
      await chooseProject(user);
      await user.type(search(bucket(1)), 'TH26-01');
      await within(bucket(1)).findByRole('option', { name: 'TH26-01' });
      await user.keyboard('{Enter}');
      expect(
        within(bucket(1)).getByRole('list', { name: 'Selected test holes' }),
      ).toHaveTextContent('TH26-01');
      expect(search(bucket(1))).not.toHaveFocus();
      expect(search(bucket(1))).toHaveAttribute('aria-expanded', 'false');
      expect(within(bucket(1)).queryByRole('listbox')).toBeNull();
      // Nothing was submitted: still on Details.
      expect(screen.getByRole('button', { name: 'Next: Review' })).toBeInTheDocument();
    });

    it('Enter on "Add …" creates the hole, selects it and leaves the search box', async () => {
      const user = userEvent.setup();
      const th3: TestHole = { id: 'th3', projectId: project.id, name: 'TH26-03' };
      renderWizard({
        [`POST /api/projects/${project.id}/test-holes`]: () => json(201, th3),
      });
      await chooseProject(user);
      await user.type(search(bucket(1)), 'TH26-03');
      await within(bucket(1)).findByRole('option', { name: 'Add TH26-03' });
      await user.keyboard('{Enter}');
      await vi.waitFor(() =>
        expect(
          within(bucket(1)).getByRole('list', { name: 'Selected test holes' }),
        ).toHaveTextContent('TH26-03'),
      );
      expect(search(bucket(1))).not.toHaveFocus();
      expect(within(bucket(1)).queryByRole('listbox')).toBeNull();
    });

    it('a failed add keeps the search box focused with the error', async () => {
      const user = userEvent.setup();
      renderWizard({
        [`POST /api/projects/${project.id}/test-holes`]: () => {
          throw new TypeError('Failed to fetch');
        },
      });
      await chooseProject(user);
      await user.type(search(bucket(1)), 'TH26-04');
      await within(bucket(1)).findByRole('option', { name: 'Add TH26-04' });
      await user.keyboard('{Enter}');
      expect(
        await within(bucket(1)).findByText(
          "The test hole couldn't be saved. Check the connection.",
        ),
      ).toBeInTheDocument();
      expect(search(bucket(1))).toHaveFocus();
      expect(search(bucket(1))).toHaveValue('TH26-04');
      expect(within(bucket(1)).queryByRole('list', { name: 'Selected test holes' })).toBeNull();
    });
  });

  it('AC5: a personal account defaults to itself; a LAB station starts blank', async () => {
    renderWizard();
    expect(await screen.findByRole('combobox', { name: 'Received by' })).toHaveValue(
      'AT · Alex Tester',
    );
  });

  it('AC5: LAB must choose the receiver before moving on', async () => {
    const user = userEvent.setup();
    renderWizard(
      {},
      me({ accountType: 'shared_lab', id: 'lab', displayName: 'LAB', initials: null }),
    );
    expect(await screen.findByRole('combobox', { name: 'Received by' })).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    expect(
      within(screen.getByRole('alert')).getByRole('link', {
        name: 'Choose who received the samples.',
      }),
    ).toBeInTheDocument();
  });
});
