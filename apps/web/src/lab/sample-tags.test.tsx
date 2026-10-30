import type { MeResponse, SampleTag, SampleTagSheet } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// Sample ID tag sheets (MM-T69). Fictional data only (DEMO-2601, TH26-01).

const me: MeResponse = {
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'lab_program.read'],
  sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  position: null,
  positionSetupRequired: false,
  profileRefreshFailed: false,
};

const PROGRAM = '00000000-0000-4000-8000-0000000000f1';

function tag(
  key: string,
  sampleLabel: string,
  tests: [string, SampleTag['tests'][number]['status']][],
) {
  return {
    key,
    lineNumbers: [1],
    source: { kind: 'test_hole', id: 'hole', label: 'TH26-01' },
    sampleLabel,
    depth: '10.0 m',
    tagGroup: null,
    tests: tests.map(([name, status], i) => ({
      requestId: `${key}-r${i}`,
      testTypeId: `t-${name}`,
      code: name.toUpperCase(),
      name,
      status,
    })),
    pending: tests.some(([, status]) => status === 'requested' || status === 'in_progress'),
  } satisfies SampleTag;
}

const sheet: SampleTagSheet = {
  program: {
    id: PROGRAM,
    programNumber: 'LP-2026-0012',
    status: 'submitted',
    project: { id: 'p', projectNumber: 'DEMO-2601', name: 'Riverbank investigation' },
  },
  tags: [
    tag('a', 'G13', [['Atterberg Limits', 'requested']]),
    tag('b', 'G13', [
      ['Sieve', 'requested'],
      ['Hydrometer', 'requested'],
    ]),
    tag('c', 'G5', [['Atterberg Limits', 'accepted']]),
  ],
  noTagTests: [
    {
      lineNumber: 1,
      sampleLabel: 'G13',
      depth: '10.0 m',
      test: {
        requestId: 'mc',
        testTypeId: 't-mc',
        code: 'MC',
        name: 'Moisture Content',
        status: 'requested',
      },
    },
  ],
  untaggedLines: [
    {
      lineNumber: 2,
      scope: 'all',
      sourceLabel: 'TH26-02',
      tests: [
        {
          requestId: 'x',
          testTypeId: 't',
          code: 'ATT',
          name: 'Atterberg Limits',
          status: 'requested',
        },
      ],
    },
  ],
};

function renderTags(response: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input).endsWith('/sample-tags') ? response() : new Response('{}', { status: 404 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, {
    initialEntries: [`/lab-testing/programs/${PROGRAM}/tags`],
  });
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

const ok = () =>
  new Response(JSON.stringify(sheet), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sample ID tags (MM-T69)', () => {
  it('selects tags with work still to do and lists what gets no tag', async () => {
    const user = userEvent.setup();
    const fetchMock = renderTags(ok);
    expect(
      await screen.findByRole('heading', { name: /Sample ID tags.*LP-2026-0012/ }),
    ).toBeVisible();
    const boxes = screen.getAllByRole('checkbox', { name: /G13|G5/ });
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, true, false]);
    expect(screen.getByText('2 of 3 tags selected · 1 sheet')).toBeVisible();
    await user.click(screen.getByText(/Not tagged: 2 items/));
    expect(screen.getByText(/G13 · 10.0 m: Moisture Content/)).toBeVisible();
    expect(screen.getByText(/Line 2 · ALL · TH26-02: Atterberg Limits/)).toBeVisible();
    // Reading tags only ever GETs.
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });

  it('splits a shared tag, never merging, and starts on a chosen card', async () => {
    const user = userEvent.setup();
    renderTags(ok);
    await user.click(await screen.findByRole('button', { name: 'Split into 2 tags' }));
    expect(screen.getByText('3 of 4 tags selected · 1 sheet')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Start at card'), '9');
    expect(screen.getByText('3 of 4 tags selected · 2 sheets')).toBeVisible();
    const preview = screen.getByLabelText('Tag sheets to print');
    const first = within(preview).getByRole('region', { name: 'Sheet 1 of 2' });
    expect(within(first).getAllByLabelText(/^Card \d+: blank$/)).toHaveLength(8);
    expect(
      within(first).getByLabelText(/Tag G13 at 10.0 m, TH26-01: Atterberg Limits/),
    ).toBeVisible();
    expect(within(preview).getByText(/Sheet 2 of 2$/)).toBeInTheDocument();
  });

  it('explains that a draft has no tags yet', async () => {
    renderTags(
      () =>
        new Response(JSON.stringify({ code: 'program_not_submitted' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(
      await screen.findByText('Sample ID tags are available once the program is submitted.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Print / Save as PDF' })).toBeNull();
  });
});
