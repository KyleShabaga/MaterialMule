import type { MeResponse, StorageUnitDetail, StorageUnitHistoryPage } from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// Fictional data only (MM-T13): BKT-2026-000014 in DEMO-2601, test hole TH26-01, user KCS.

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};

const UNIT: StorageUnitDetail = {
  id: '00000000-0000-4000-8000-000000000501',
  readableId: 'BKT-2026-000014',
  unitType: 'bucket',
  status: 'in_stock',
  note: 'Lid taped',
  receivedDate: '2026-10-23',
  minimumRetainUntil: '2027-10-23',
  version: 1,
  project: PROJECT,
  sample: null,
  bulkGroup: null,
  holes: [
    {
      testHoleId: '00000000-0000-4000-8000-000000000301',
      testHoleName: 'TH26-01',
      type: 'all',
      sampleFrom: null,
      sampleTo: null,
      depthFrom: null,
      depthTo: null,
      depthUnit: null,
      customText: null,
      note: null,
    },
  ],
  location: { id: 'loc-w', code: 'WH-C2', name: 'Warehouse C2' },
  receipt: {
    id: 'r1',
    receivedDate: '2026-10-23',
    project: PROJECT,
    receiver: { initials: 'AT', name: 'Alex Tester' },
    account: { initials: null, name: 'LAB' },
    description: null,
    quantity: 1,
    confirmedAt: '2026-10-23T16:00:00.000Z',
  },
};

const CORRECTED_HISTORY: StorageUnitHistoryPage = {
  items: [
    {
      id: 'e2',
      occurredAt: '2026-10-26T16:00:00.000Z',
      action: 'storage_unit.corrected',
      actor: { initials: 'KCS', name: 'Kim Example', accountType: 'personal' },
      receiver: null,
      reason: 'wrong date on tag',
      before: { receivedDate: '2026-10-23' },
      after: { receivedDate: '2026-10-21' },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

const OTHER_PROJECT = {
  id: '00000000-0000-4000-8000-000000000202',
  projectNumber: 'DEMO-2602',
  name: 'Hillside bridge',
  client: 'Example Client',
  leadProjectEngineer: { id: 'u-pe', displayName: 'Pat Example', initials: 'PE' },
};

const EMPTY_HISTORY: StorageUnitHistoryPage = { items: [], total: 0, page: 1, pageSize: 20 };

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Kim Example',
  initials: 'KCS',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'label.print', 'storage_unit.correct'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Api {
  unit: StorageUnitDetail;
  history: StorageUnitHistoryPage;
  patch: (body: unknown) => Response;
  /** Project search answer for a query; defaults to DEMO-2602 for every query. */
  projects?: (query: string) => unknown[];
}

function stubApi(api: Api) {
  const patches: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/health') return json(200, { status: 'ok' });
    if (url.pathname === `/api/storage-units/${UNIT.id}` && method === 'PATCH') {
      const body: unknown = JSON.parse(String(init?.body));
      patches.push(body);
      return api.patch(body);
    }
    if (url.pathname === `/api/storage-units/${UNIT.readableId}`) return json(200, api.unit);
    if (url.pathname === `/api/storage-units/${UNIT.id}/history`) return json(200, api.history);
    if (url.pathname.endsWith('/print-history')) {
      return json(200, { storageUnit: { id: UNIT.id, readableId: UNIT.readableId }, jobs: [] });
    }
    if (url.pathname === '/api/projects/search') {
      return json(200, api.projects?.(url.searchParams.get('q') ?? '') ?? [OTHER_PROJECT]);
    }
    if (url.pathname === '/api/staff/active') return json(200, []);
    if (url.pathname === `/api/projects/${OTHER_PROJECT.id}/test-holes`) return json(200, []);
    if (url.pathname === `/api/projects/${PROJECT.id}/test-holes`) {
      return json(200, [{ id: UNIT.holes[0]!.testHoleId, projectId: PROJECT.id, name: 'TH26-01' }]);
    }
    return json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return patches;
}

function renderUnit(user = me()) {
  const router = createMemoryRouter(routes, {
    initialEntries: [`/sample-storage/${UNIT.readableId}`],
  });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storage unit corrections (MM-T13)', () => {
  it('AC1: corrects the received date with a reason, then shows the new values and history', async () => {
    const corrected: StorageUnitDetail = {
      ...UNIT,
      receivedDate: '2026-10-21',
      minimumRetainUntil: '2027-10-21',
      version: 2,
    };
    const api: Api = {
      unit: UNIT,
      history: EMPTY_HISTORY,
      patch: () => {
        api.unit = corrected;
        api.history = CORRECTED_HISTORY;
        return json(200, corrected);
      },
    };
    const patches = stubApi(api);
    const user = userEvent.setup();
    renderUnit();

    await user.click(await screen.findByRole('button', { name: 'Correct details' }));
    // MM-T50: Correct details is its own view; focus moves to its heading.
    expect(screen.getByRole('heading', { level: 1, name: 'Correct details' })).toHaveFocus();
    expect(screen.queryByRole('region', { name: 'Summaries' })).not.toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Correct details' });
    expect(within(form).queryByText('Changed')).not.toBeInTheDocument();
    expect(within(form).getByText('Nothing changed yet')).toBeInTheDocument();
    const date = within(form).getByLabelText('Received date');
    expect(date).toHaveValue('2026-10-23');
    await user.clear(date);
    await user.type(date, '2026-10-21');
    expect(within(form).getByText('Changed')).toBeInTheDocument();
    expect(within(form).getByText('1 field changed')).toBeInTheDocument();
    expect(
      within(form).getByText(
        'Was 2026-10-23. The minimum retain-until date (received date + 1 year) follows it.',
      ),
    ).toBeInTheDocument();
    expect(
      within(form).getByText(
        'Printed labels show the values at print time. Reprint if the label is now wrong.',
      ),
    ).toBeInTheDocument();

    // AC3: no reason, no save.
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    expect(
      await within(form).findByText('Enter a reason (at least 5 characters).'),
    ).toBeInTheDocument();
    expect(patches).toHaveLength(0);

    await user.type(within(form).getByLabelText('Reason for the correction'), 'wrong date on tag');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));

    expect(await screen.findByText('2027-10-21')).toBeInTheDocument();
    expect(patches).toEqual([
      { version: 1, reason: 'wrong date on tag', changes: { receivedDate: '2026-10-21' } },
    ]);
    expect(screen.queryByRole('form', { name: 'Correct details' })).not.toBeInTheDocument();
    expect(screen.getByText('Details corrected.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Correct details' })).toHaveFocus();
    const summaries = screen.getByRole('region', { name: 'Summaries' });
    expect(within(summaries).getByText('2026-10-21')).toBeInTheDocument();
    const receipt = screen.getByRole('region', { name: 'Receipt' });
    expect(within(receipt).getByText('2026-10-23')).toBeInTheDocument();
    const history = screen.getByRole('region', { name: 'History' });
    expect(
      await within(history).findByText(
        'KCS changed received date 2026-10-23 → 2026-10-21 · Reason: wrong date on tag',
      ),
    ).toBeInTheDocument();
  });

  it('MM-T50: Back to the unit leaves Correct details without saving', async () => {
    const patches = stubApi({ unit: UNIT, history: EMPTY_HISTORY, patch: () => json(500, {}) });
    const user = userEvent.setup();
    renderUnit();

    await user.click(await screen.findByRole('button', { name: 'Correct details' }));
    await user.type(screen.getByLabelText('Storage unit note'), ' and wet');
    await user.click(screen.getByRole('button', { name: '← Back to BKT-2026-000014' }));

    expect(screen.queryByRole('form', { name: 'Correct details' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Correct details' })).toHaveFocus();
    expect(
      within(screen.getByRole('region', { name: 'Summaries' })).getByText('Lid taped'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Details corrected.')).not.toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });

  it('BUG-014: a disposed unit offers only its received date and note', async () => {
    const disposed: StorageUnitDetail = { ...UNIT, status: 'disposed' };
    const patches = stubApi({
      unit: disposed,
      history: EMPTY_HISTORY,
      patch: () => json(200, { ...disposed, note: 'Lid replaced', version: 2 }),
    });
    const user = userEvent.setup();
    renderUnit();

    await user.click(await screen.findByRole('button', { name: 'Correct details' }));
    const form = screen.getByRole('form', { name: 'Correct details' });
    expect(
      within(form).getByText(
        'This storage unit is disposed: its type, project, sampling source and test holes stay as they are.',
      ),
    ).toBeInTheDocument();
    expect(within(form).queryByLabelText('Type')).not.toBeInTheDocument();
    expect(within(form).queryByRole('group', { name: 'Project' })).not.toBeInTheDocument();
    expect(within(form).getByLabelText('Received date')).toBeInTheDocument();
    const note = within(form).getByLabelText('Storage unit note');
    await user.clear(note);
    await user.type(note, 'Lid replaced');
    await user.type(within(form).getByLabelText('Reason for the correction'), 'lid was swapped');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));

    expect(await screen.findByText('Details corrected.')).toBeInTheDocument();
    expect(patches).toEqual([
      { version: 1, reason: 'lid was swapped', changes: { note: 'Lid replaced' } },
    ]);
  });

  it("MM-T82: corrects a Shelby tube's sampling source, and says plainly when testing blocks it", async () => {
    const tube: StorageUnitDetail = {
      ...UNIT,
      unitType: 'shelby_tube',
      holes: [],
      sample: {
        source: {
          type: 'test_hole',
          testHoleId: UNIT.holes[0]!.testHoleId,
          testHoleName: 'TH26-01',
        },
        sampleReference: 'T5',
        depthFrom: null,
        depthTo: null,
        depthUnit: null,
      },
    };
    let tested = true;
    const patches = stubApi({
      unit: tube,
      history: EMPTY_HISTORY,
      patch: () =>
        tested
          ? json(422, {
              code: 'storage_unit_tested',
              errors: [
                {
                  field: 'changes.sample',
                  code: 'storage_unit_tested',
                  message: 'is not corrected for a unit used in a completed test',
                },
              ],
            })
          : json(200, {
              ...tube,
              version: 2,
              sample: {
                ...tube.sample!,
                source: { type: 'standalone_location', locationReference: 'Pit 4' },
              },
            }),
    });
    const user = userEvent.setup();
    renderUnit();

    await user.click(await screen.findByRole('button', { name: 'Correct details' }));
    const form = screen.getByRole('form', { name: 'Correct details' });
    expect(within(form).queryByText(/can’t be corrected here yet/)).not.toBeInTheDocument();
    expect(within(form).queryByLabelText('Type')).not.toBeInTheDocument();
    const source = within(form).getByRole('group', { name: 'Sampling source' });
    expect(within(source).getByText('TH26-01: T5')).toBeInTheDocument();
    await user.click(within(source).getByRole('button', { name: 'Change sampling source' }));
    await user.click(within(source).getByRole('radio', { name: 'Standalone sampling location' }));
    await user.type(within(source).getByLabelText('Location reference'), 'Pit 4');
    expect(within(form).getByText('1 field changed')).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Reason for the correction'), 'tag misread');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));

    expect(
      await within(form).findByText(
        'This unit was used in a completed test: its sampling source and bulk sample can’t change.',
      ),
    ).toBeInTheDocument();
    const sent = {
      version: 1,
      reason: 'tag misread',
      changes: {
        sample: {
          sourceType: 'standalone_location',
          sourceLocationReference: 'Pit 4',
          sampleReference: 'T5',
          depthFrom: null,
          depthTo: null,
          depthUnit: null,
        },
      },
    };
    expect(patches).toEqual([sent]);

    tested = false;
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    expect(await screen.findByText('Details corrected.')).toBeInTheDocument();
    expect(patches).toEqual([sent, sent]);
  });

  it('AC2: LAB sees no Correct action and an explanation', async () => {
    stubApi({ unit: UNIT, history: EMPTY_HISTORY, patch: () => json(403, {}) });
    renderUnit(
      me({
        accountType: 'shared_lab',
        initials: null,
        displayName: 'LAB',
        permissions: ['inventory.read', 'label.print'],
      }),
    );
    expect(await screen.findByText('Corrections need a personal account.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Correct details' })).not.toBeInTheDocument();
  });

  it('AC4: a version conflict shows the message and the latest values', async () => {
    const latest: StorageUnitDetail = { ...UNIT, note: 'Changed by someone else', version: 2 };
    const api: Api = {
      unit: UNIT,
      history: EMPTY_HISTORY,
      patch: () => {
        api.unit = latest;
        return json(409, { code: 'version_conflict', currentVersion: 2 });
      },
    };
    stubApi(api);
    const user = userEvent.setup();
    renderUnit();

    await user.click(await screen.findByRole('button', { name: 'Correct details' }));
    const note = screen.getByLabelText('Storage unit note');
    await user.clear(note);
    await user.type(note, 'My note');
    await user.type(screen.getByLabelText('Reason for the correction'), 'note was wrong');
    await user.click(screen.getByRole('button', { name: 'Save correction' }));

    // The form restarts from the reloaded unit (new version), replacing its elements, so wait for
    // the latest values first and only then look for the message.
    await waitFor(() =>
      expect(screen.getByLabelText('Storage unit note')).toHaveValue('Changed by someone else'),
    );
    expect(
      screen.getByText('Someone else changed this unit. Review the latest values and try again.'),
    ).toBeInTheDocument();
  });

  it('MM-T61: Enter in the project search picks the match and never submits the form', async () => {
    const patches = stubApi({ unit: UNIT, history: EMPTY_HISTORY, patch: () => json(500, {}) });
    const user = userEvent.setup();
    renderUnit();

    await user.click(await screen.findByRole('button', { name: 'Correct details' }));
    const form = screen.getByRole('form', { name: 'Correct details' });
    await user.click(within(form).getByRole('button', { name: 'Change project' }));
    // Saving with no project chosen yet asks for one.
    await user.type(within(form).getByLabelText('Reason for the correction'), 'wrong project');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    expect(
      await within(form).findByText('Choose the new project, or keep the current one.'),
    ).toBeInTheDocument();

    const search = within(form).getByRole('combobox', { name: /Find project/ });
    await user.type(search, 'DEMO-2602');
    await within(form).findByRole('option', { name: /DEMO-2602/ });
    await user.keyboard('{Enter}');

    expect(within(form).getByLabelText('Project number')).toHaveValue('DEMO-2602');
    // The project error is gone, and nothing was submitted.
    expect(
      within(form).queryByText('Choose the new project, or keep the current one.'),
    ).not.toBeInTheDocument();
    expect(patches).toHaveLength(0);
    expect(within(form).queryByText(/Enter a reason/)).not.toBeInTheDocument();
  });

  it('MM-T62: after a query round trip, Enter in the project search picks the first match', async () => {
    const third = {
      ...OTHER_PROJECT,
      id: '00000000-0000-4000-8000-000000000203',
      projectNumber: 'DEMO-2603',
      name: 'Old Mill Road',
    };
    const patches = stubApi({
      unit: UNIT,
      history: EMPTY_HISTORY,
      patch: () => json(500, {}),
      projects: (query) => [OTHER_PROJECT, third].filter((p) => p.projectNumber.includes(query)),
    });
    const user = userEvent.setup();
    renderUnit();

    await user.click(await screen.findByRole('button', { name: 'Correct details' }));
    const form = screen.getByRole('form', { name: 'Correct details' });
    await user.click(within(form).getByRole('button', { name: 'Change project' }));
    const search = within(form).getByRole('combobox', { name: /Find project/ });
    // Only the search's own list (the form has other selects with options).
    const matches = () =>
      within(document.getElementById(search.getAttribute('aria-controls')!)!).getAllByRole(
        'option',
      );
    await user.type(search, 'DEMO');
    await waitFor(() => expect(matches()).toHaveLength(2));
    await user.keyboard('{ArrowDown}');
    await user.type(search, '-2603');
    await waitFor(() => expect(matches()).toHaveLength(1));
    await user.keyboard('{Backspace}'.repeat(5));
    await waitFor(() => expect(matches()).toHaveLength(2));
    expect(search).toHaveAttribute('aria-activedescendant', matches()[0]!.id);
    await user.keyboard('{Enter}');

    expect(within(form).getByLabelText('Project number')).toHaveValue('DEMO-2602');
    expect(patches).toHaveLength(0);
  });

  it('AC5: lists unresolved lab requests when a project change is blocked', async () => {
    stubApi({
      unit: UNIT,
      history: EMPTY_HISTORY,
      patch: () =>
        json(409, {
          code: 'unresolved_lab_links',
          links: [{ id: 'lr1', label: 'LR-2026-0012', status: 'in progress' }],
        }),
    });
    const user = userEvent.setup();
    renderUnit();

    await user.click(await screen.findByRole('button', { name: 'Correct details' }));
    // A summary change goes through the same save path as a project change.
    await user.selectOptions(screen.getByLabelText('Summary type'), 'custom');
    await user.type(screen.getByLabelText('Custom summary'), 'Bags 1-3');
    await user.type(screen.getByLabelText('Reason for the correction'), 'summary was wrong');
    await user.click(screen.getByRole('button', { name: 'Save correction' }));

    const list = await screen.findByRole('list', { name: 'Unresolved lab requests' });
    expect(list).toHaveTextContent('LR-2026-0012 (in progress)');
  });

  it('MM-T70: a project change on an approved unit is refused in plain words with a Disposal link', async () => {
    const message =
      'BKT-2026-000014 is approved for disposal under DEMO-2601. Revoke the approval on the ' +
      'Disposal & Retention page first, then correct the project.';
    stubApi({
      unit: UNIT,
      history: EMPTY_HISTORY,
      patch: () =>
        json(422, {
          code: 'disposal_approval_live',
          projectId: 'p-demo-2601',
          projectNumber: 'DEMO-2601',
          message,
        }),
    });
    const user = userEvent.setup();
    renderUnit();

    await user.click(await screen.findByRole('button', { name: 'Correct details' }));
    await user.selectOptions(screen.getByLabelText('Summary type'), 'custom');
    await user.type(screen.getByLabelText('Custom summary'), 'Bags 1-3');
    await user.type(screen.getByLabelText('Reason for the correction'), 'wrong project');
    await user.click(screen.getByRole('button', { name: 'Save correction' }));

    const alert = await screen.findByText(message);
    expect(alert).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Disposal & Retention' })).toHaveAttribute(
      'href',
      '/disposal-retention?projectId=p-demo-2601',
    );
    // The form stays open with what was typed.
    expect(screen.getByRole('form', { name: 'Correct details' })).toBeInTheDocument();
  });
});
