import type { BulkGroupSummary, MeResponse, ProjectSummary, TestHole } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// MM-T36 receiving: Shelby tubes with a test-hole or standalone sampling source, bulk soil
// buckets sharing a bulk sample, both review layouts, joining an existing sample, the source
// picker's keyboard contract and Alt+N. Every project, person, hole and location is fictional.

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
const th21: TestHole = {
  id: '00000000-0000-4000-8000-000000000921',
  projectId: project.id,
  name: 'TH26-21',
};
const th22: TestHole = {
  id: '00000000-0000-4000-8000-000000000922',
  projectId: project.id,
  name: 'TH26-22',
};
const stockpileB1: BulkGroupSummary = {
  id: '00000000-0000-4000-8000-000000000951',
  projectId: project.id,
  identity: {
    source: { type: 'standalone_location', locationReference: 'Stockpile 2' },
    sampleReference: 'B1',
    depthFrom: 0.5,
    depthTo: null,
    depthUnit: 'm',
  },
  description: null,
  memberCount: 2,
  version: 4,
};

const me: MeResponse = {
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
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (body: unknown) => Response | Promise<Response>;

function renderWizard(extra: Record<string, Handler> = {}) {
  const api: Record<string, Handler> = {
    'GET /api/projects/search': () => json(200, [project]),
    [`GET /api/projects/${project.id}/test-holes`]: () => json(200, [th21, th22]),
    [`GET /api/projects/${project.id}/bulk-groups`]: () => json(200, [stockpileB1]),
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
        session: { status: 'active', me },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

/** matchMedia answering `wide` for exactly the "> 1280px" query (the review layout switch). */
function stubWidth(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide && query === '(width > 1280px)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
const region = (name: string) => screen.getByRole('region', { name });

async function chooseProject(user: User) {
  await user.type(await screen.findByRole('combobox', { name: /Find project/ }), 'river');
  await user.click(await screen.findByRole('option', { name: /DEMO-2601/ }, { timeout: 5_000 }));
}

/** Picks a test-hole sampling source by typing and pressing Enter (single-hole picker). */
async function pickSourceHole(user: User, unit: HTMLElement, name: string) {
  await user.click(within(unit).getByRole('radio', { name: 'Test hole' }));
  const search = within(unit).getByRole('combobox', { name: /test hole/ });
  await user.type(search, name);
  await within(unit).findByRole('option', { name });
  await user.keyboard('{Enter}');
}

/**
 * Bucket 1: bulk B1 from TH26-21 at 1.5–2 m, duplicated as Bucket 2 (same sample); unit 3: a
 * Shelby tube from TH26-21 (T5); unit 4: a Shelby tube from a standalone location at 10–12 ft.
 */
async function fillMixedReceipt(user: User) {
  await chooseProject(user);
  const b1 = region('Bucket 1');
  await user.click(within(b1).getByRole('checkbox', { name: 'Bulk soil sample' }));
  expect(within(b1).getByText(/commonly fills one or two buckets/)).toBeInTheDocument();
  // Bulk replaces test-hole summaries: no hole search for this bucket.
  expect(within(b1).queryByRole('combobox', { name: 'Find or add a test hole' })).toBeNull();
  await pickSourceHole(user, b1, 'TH26-21');
  expect(within(b1).getByPlaceholderText('B1')).toBeInTheDocument();
  await user.type(within(b1).getByLabelText(/^Sample reference/), 'B1');
  await user.type(within(b1).getByLabelText(/^Depth( \(optional\))?$/), '1.5');
  await user.type(within(b1).getByLabelText(/^Depth to/), '2');
  await user.click(within(b1).getByRole('radio', { name: 'm' }));

  await user.click(within(b1).getByRole('button', { name: 'Duplicate Bucket 1' }));
  expect(within(region('Bucket 2')).getByLabelText('Bulk sample')).toHaveDisplayValue(
    'Same as Bucket 1: TH26-21: B1 at 1.5–2 m',
  );

  await user.click(screen.getByRole('button', { name: 'Add bucket' }));
  await user.selectOptions(
    within(region('Bucket 3')).getByLabelText('Physical holder'),
    'shelby_tube',
  );
  const tube3 = region('Shelby tube 3');
  await pickSourceHole(user, tube3, 'TH26-21');
  await user.type(within(tube3).getByLabelText(/^Sample reference/), 'T5');

  await user.click(screen.getByRole('button', { name: 'Add bucket' }));
  await user.selectOptions(
    within(region('Bucket 4')).getByLabelText('Physical holder'),
    'shelby_tube',
  );
  const tube4 = region('Shelby tube 4');
  await user.click(within(tube4).getByRole('radio', { name: 'Standalone sampling location' }));
  await user.type(
    within(tube4).getByRole('textbox', { name: 'Location reference' }),
    'Embankment Location 03',
  );
  await user.type(within(tube4).getByLabelText(/^Depth( \(optional\))?$/), '10');
  await user.type(within(tube4).getByLabelText(/^Depth to/), '12');
  await user.click(within(tube4).getByRole('radio', { name: 'ft' }));
}

// Each test drives a whole multi-unit receipt by keyboard and mouse, so it gets more time than
// the 5 s default when the full suite runs in parallel.
describe('MM-T36 receiving wizard', { timeout: 30_000 }, () => {
  it('receives bulk buckets and Shelby tubes; review above 1280px shows sources and groups (T6, T8)', async () => {
    stubWidth(true);
    const user = userEvent.setup();
    const posts: unknown[] = [];
    renderWizard({
      'POST /api/receipts': (body) => {
        posts.push(body);
        const units = (body as { units: { clientRowId: string; unitType: string }[] }).units;
        return json(201, {
          receiptId: '00000000-0000-4000-8000-000000000980',
          units: units.map((u, i) => ({
            clientRowId: u.clientRowId,
            storageUnitId: `00000000-0000-4000-8000-00000000099${i}`,
            suNumber: u.unitType === 'shelby_tube' ? `ST-2026-00000${i}` : `BKT-2026-00000${i + 1}`,
          })),
        });
      },
    });
    await fillMixedReceipt(user);
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));

    const table = await screen.findByRole('table', { name: 'Storage units in this receipt' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Bucket · Bulk soil sample'),
      expect.stringContaining('bucket 2 of 2 in this receipt'),
      expect.stringContaining('Shelby tube'),
      expect.stringContaining('Embankment Location 03: 10–12 ft'),
    ]);
    expect(rows[0]).toHaveTextContent('TH26-21: B1 at 1.5–2 m · bucket 1 of 2 in this receipt');
    expect(rows[2]).toHaveTextContent('Sampling source TH26-21: T5');
    const bulk = screen.getByRole('table', { name: 'Bulk samples in this receipt' });
    expect(within(bulk).getAllByRole('row')[1]).toHaveTextContent(
      'TH26-21: B1 at 1.5–2 m (new bulk sample)2 bucketsBucket 1, Bucket 2',
    );

    await user.click(screen.getByRole('button', { name: 'Confirm receipt' }));
    expect(await screen.findByRole('heading', { name: 'ST-2026-000002' })).toBeInTheDocument();
    const body = posts[0] as {
      bulkGroups: { key: string }[];
      units: Record<string, unknown>[];
    };
    expect(body.bulkGroups).toHaveLength(1);
    expect(body.units.map((u) => u.unitType)).toEqual([
      'bucket',
      'bucket',
      'shelby_tube',
      'shelby_tube',
    ]);
    expect(body.units[0]!.bulkGroup).toEqual({ newGroupKey: body.bulkGroups[0]!.key });
    expect(body.units[1]!.bulkGroup).toEqual({ newGroupKey: body.bulkGroups[0]!.key });
    expect(body.units[3]!.sample).toMatchObject({
      sourceType: 'standalone_location',
      sourceLocationReference: 'Embankment Location 03',
    });
    expect(body.units[3]!.sample).not.toHaveProperty('testHoleId');
  });

  it('shows the same information in cards at 1280px and below', async () => {
    stubWidth(false);
    const user = userEvent.setup();
    renderWizard();
    await fillMixedReceipt(user);
    await user.click(screen.getByRole('button', { name: 'Next: Review' }));
    expect(screen.queryByRole('table', { name: 'Storage units in this receipt' })).toBeNull();
    const first = await screen.findByRole('region', { name: 'Bucket 1' });
    expect(first).toHaveTextContent('TypeBucket · Bulk soil sample');
    expect(first).toHaveTextContent('Bulk sampleTH26-21: B1 at 1.5–2 m · bucket 1 of 2');
    expect(region('Shelby tube 4')).toHaveTextContent(
      'Sampling sourceEmbankment Location 03: 10–12 ft',
    );
    expect(region('Bulk samples in this receipt')).toHaveTextContent(
      '2 buckets (new bulk sample): Bucket 1, Bucket 2',
    );
  });

  it('a later bucket joins an existing bulk sample shown by source, reference and depth (AC2)', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    renderWizard({
      'POST /api/receipts': (body) => {
        posts.push(body);
        return json(500, {});
      },
    });
    await chooseProject(user);
    const b1 = region('Bucket 1');
    await user.click(within(b1).getByRole('checkbox', { name: 'Bulk soil sample' }));
    const choice = within(b1).getByLabelText('Bulk sample');
    await within(b1).findByRole('option', { name: 'Stockpile 2 · B1 · 0.5 m — 2 buckets so far' });
    await user.selectOptions(choice, `existing:${stockpileB1.id}`);
    // Joining inherits the identity: nothing about the sample is typed again.
    expect(within(b1).queryByLabelText(/^Sample reference/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Bucket 1' }).closest('section')).toHaveTextContent(
      'Bulk soil sample · Stockpile 2 · B1 · 0.5 m',
    );
  });

  it('the sampling source picker keeps the Enter/close/blur contract and holds one hole', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await user.selectOptions(
      within(region('Bucket 1')).getByLabelText('Physical holder'),
      'shelby_tube',
    );
    const tube = region('Shelby tube 1');
    await pickSourceHole(user, tube, 'TH26-21');
    const search = within(tube).getByRole('combobox', { name: 'Change the test hole' });
    expect(search).not.toHaveFocus();
    expect(search).toHaveAttribute('aria-expanded', 'false');
    expect(within(tube).getByRole('list', { name: 'Selected test hole' })).toHaveTextContent(
      'TH26-21',
    );
    // Choosing another hole replaces the first: a tube has exactly one source.
    await user.type(search, 'TH26-22');
    await within(tube).findByRole('option', { name: 'TH26-22' });
    await user.keyboard('{Enter}');
    const chosen = within(tube).getByRole('list', { name: 'Selected test hole' });
    expect(chosen).toHaveTextContent('TH26-22');
    expect(chosen).not.toHaveTextContent('TH26-21');
  });

  it('Alt+N still adds a bucket and goes to its test hole search, past the new holder controls', async () => {
    const user = userEvent.setup();
    renderWizard();
    await chooseProject(user);
    await user.click(
      within(region('Bucket 1')).getByRole('checkbox', { name: 'Bulk soil sample' }),
    );
    await user.keyboard('{Alt>}n{/Alt}');
    const second = region('Bucket 2');
    expect(within(second).getByRole('combobox', { name: 'Find or add a test hole' })).toHaveFocus();
    // The holder select and Bulk soil sample box come before it (one Shift+Tab away).
    expect(within(second).getByLabelText('Physical holder')).toHaveValue('bucket');
    expect(within(second).getByRole('checkbox', { name: 'Bulk soil sample' })).not.toBeChecked();
  });
});
