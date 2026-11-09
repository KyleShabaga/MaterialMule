import {
  concreteReviewChecklist,
  type ConcreteFieldReportDetail,
  type ConcreteReportVersionDetail,
  type ConcreteReviewQueue,
  type MeResponse,
} from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import {
  detail,
  fields,
  json,
  me,
  PEOPLE,
  PROJECT_ID,
  READING_ID,
  REPORT_ID,
  versionDetail,
  versionSummary,
} from './fixtures.test-support';
import { issueBlock, markReviewedBlock, returnBlock, whoCanReview } from './rules';

// MM-V2-C28 UI: queue, review view (AC1 disabled reason, AC2 comment required, AC3 changed fields
// highlighted with the full record) and issue view options. Fictional data only (DEMO-2601).

beforeAll(() => {
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => vi.unstubAllGlobals());

type Api = (url: string, init?: RequestInit) => Response | undefined;

function renderAt(path: string, user: MeResponse, api: Api) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return api(url, init) ?? json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

/** The API for one report: its detail, versions (latest last) and notes. */
function reportApi(
  report: ConcreteFieldReportDetail,
  versions: ConcreteReportVersionDetail[],
  extra: Api = () => undefined,
): Api {
  return (url, init) => {
    const own = extra(url, init);
    if (own) return own;
    const base = `/api/concrete/field-reports/${REPORT_ID}`;
    if (url === base) return json(200, report);
    if (url === `${base}/versions`) {
      return json(200, {
        reportId: REPORT_ID,
        versions: versions.map((v) => {
          const { snapshot: _s, reportId: _r, ...summary } = v;
          void _s;
          void _r;
          return summary;
        }),
        transitions: [],
      });
    }
    const version = url.match(/\/versions\/(\d+)(\/exception-notes)?$/);
    if (version) {
      const found = versions.find((v) => v.versionNo === Number(version[1]));
      if (!found) return json(404, { code: 'concrete_report_version_not_found' });
      if (version[2])
        return json(200, { reportId: REPORT_ID, versionNo: found.versionNo, notes: [] });
      return json(200, found);
    }
    if (url === `/api/projects/${PROJECT_ID}/concrete-settings`) {
      return json(200, {
        projectId: PROJECT_ID,
        defaultSpecimenAges: [7, 28, 28, 'HOLD'],
        holdDurationDays: 56,
        includeMachineInfo: null,
        version: 0,
        updatedAt: null,
        updatedBy: null,
        canEdit: false,
        history: [],
        historyTotal: 0,
      });
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------------------------

describe('review rules', () => {
  const open = concreteReviewChecklist({
    submitted: detail().review.warnings,
    live: detail().review.warnings,
    notes: [],
  });

  it('AC1: Mark reviewed says why while an exception is open', () => {
    expect(markReviewedBlock({ me: me('rv'), detail: detail(), open })).toBe(
      '1 exception is still open. Resolve or document each one first.',
    );
    expect(markReviewedBlock({ me: me('rv'), detail: detail(), open: [] })).toBeNull();
  });

  it('never the technician, never LAB, and says who can act', () => {
    expect(markReviewedBlock({ me: me('tech'), detail: detail(), open: [] })).toMatch(
      /You are this report’s technician/,
    );
    expect(
      markReviewedBlock({
        me: me('rv', { accountType: 'shared_lab' }),
        detail: detail(),
        open: [],
      }),
    ).toMatch(/shared LAB account/);
    const routed = detail({
      allowedActions: [],
      latest: versionSummary(2, {
        route: { kind: 'original_reviewer', routedTo: PEOPLE.rv, reason: 'resubmission' },
      }),
    });
    expect(markReviewedBlock({ me: me('js'), detail: routed, open: [] })).toBe(
      'Only Riley Reviewer (routed to them) or the Lead Project Engineer (Pat Example) can review this report.',
    );
    expect(whoCanReview(detail())).toBe(
      'a designated reviewer (Riley Reviewer) or the Lead Project Engineer (Pat Example)',
    );
    expect(returnBlock({ me: me('js'), detail: detail({ allowedActions: [] }) })).toMatch(
      /^Only a designated reviewer/,
    );
  });

  it('issue waits for a reviewed report and authority, never a machine-info choice (C38)', () => {
    const reviewed = detail({ state: 'reviewed', allowedActions: ['issue', 'return'] });
    expect(issueBlock({ me: me('js'), detail: reviewed, issuers: null })).toBeNull();
    expect(issueBlock({ me: me('tech'), detail: reviewed, issuers: null })).toMatch(
      /Someone else must issue it/,
    );
    expect(issueBlock({ me: me('js'), detail: detail(), issuers: null })).toBe(
      'Only a reviewed report can be issued.',
    );
  });
});

// ---------------------------------------------------------------------------------------------

describe('Review queue page', () => {
  const queue = (overrides: Partial<ConcreteReviewQueue> = {}): ConcreteReviewQueue => ({
    items: [
      {
        reportId: REPORT_ID,
        reportType: 'field',
        setId: null,
        setLabel: null,
        projectId: PROJECT_ID,
        projectNumber: 'DEMO-2601',
        projectName: 'Fictional project',
        reportDate: '2026-11-08',
        technician: PEOPLE.tech,
        status: 'awaiting_review',
        versionNo: 2,
        revisionOfVersionNo: null,
        revised: false,
        submittedAt: '2026-11-08T18:00:00.000Z',
        route: { kind: 'original_reviewer', routedTo: PEOPLE.rv },
        reviewedBy: null,
        reviewedAt: null,
        returnedBy: null,
        returnedAt: null,
        issuedBy: null,
        issuedAt: null,
        exceptions: [{ code: 'slump_out_of_range', count: 1 }],
        documentedCount: 0,
        canAct: true,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 25,
    counts: { awaiting_review: 1, returned: 2, reviewed_awaiting_issue: 0, issued: 5 },
    ...overrides,
  });

  it('shows the four statuses with counts and each row’s columns and flags', async () => {
    const fetchMock = renderAt('/concrete/review', me('rv'), (url) =>
      url.startsWith('/api/concrete/review-queue') ? json(200, queue()) : undefined,
    );
    const table = await screen.findByRole('table', { name: /Awaiting review/ });
    const tabs = screen.getByRole('tablist', { name: 'Queue status' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual([
      'Awaiting review (1)',
      'Returned for correction (2)',
      'Reviewed awaiting issuance (0)',
      'Issued (5)',
    ]);
    const row = within(table).getAllByRole('row')[1]!;
    expect(within(row).getByRole('link', { name: 'DEMO-2601' })).toHaveAttribute(
      'href',
      `/concrete/review/${REPORT_ID}`,
    );
    expect(row).toHaveTextContent('Field report v2');
    expect(row).toHaveTextContent('2026-11-08');
    expect(row).toHaveTextContent('Alex Tester');
    expect(row).toHaveTextContent('Slump out of range');
    expect(row).toHaveTextContent('Routed to Riley Reviewer');
    expect(row).toHaveTextContent('Your action');

    await userEvent.click(within(tabs).getByRole('tab', { name: /Issued/ }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
        '/api/concrete/review-queue?status=issued&exceptions=any&page=1',
      ),
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Needs my action' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
        '/api/concrete/review-queue?status=issued&exceptions=any&mine=true&page=1',
      ),
    );
  });
});

// ---------------------------------------------------------------------------------------------

describe('Review view', () => {
  const v1 = versionDetail(1, fields({ ticketNumber: 'T-099' }), {
    state: 'returned',
    closed: {
      kind: 'returned',
      by: PEOPLE.rv,
      at: '2026-11-08T18:30:00.000Z',
      comment: 'Ticket number is wrong',
    },
  });
  const v2 = versionDetail(2, fields(), {
    route: { kind: 'original_reviewer', routedTo: PEOPLE.rv, reason: 'resubmission' },
  });
  const current = detail({
    latest: versionSummary(2, {
      route: { kind: 'original_reviewer', routedTo: PEOPLE.rv, reason: 'resubmission' },
    }),
  });

  it('AC1/AC3: interim preview, only the changed field marked, Mark reviewed disabled with why', async () => {
    renderAt(`/concrete/review/${REPORT_ID}`, me('rv'), reportApi(current, [v1, v2]));
    const preview = await screen.findByRole('article', { name: /Review preview · version 2/ });
    expect(preview).toHaveTextContent('This is not the issued report format.');
    // AC3: the ticket number changed, the truck number didn't; both are shown.
    const ticket = preview.querySelector('[data-path="fields.ticketNumber"]')!;
    expect(ticket).toHaveTextContent('T-100');
    expect(ticket).toHaveTextContent('Changed (was T-099)');
    const truck = preview.querySelector('[data-path="fields.truckNumber"]')!;
    expect(truck).toHaveTextContent('T-7');
    expect(truck).not.toHaveTextContent('Changed');
    expect(preview.querySelectorAll('.review-changed-mark')).toHaveLength(1);
    expect(screen.getByText(/1 field changed/)).toBeInTheDocument();
    expect(screen.getByText(/Returned by Riley Reviewer/)).toHaveTextContent(
      'Ticket number is wrong',
    );

    // AC1: one open exception → Mark reviewed disabled, with the reason.
    const mark = screen.getByRole('button', { name: 'Mark reviewed' });
    expect(mark).toBeDisabled();
    expect(mark).toHaveAccessibleDescription(
      '1 exception is still open. Resolve or document each one first.',
    );
    const checklist = screen.getByRole('complementary', { name: 'Review checklist' });
    expect(checklist).toHaveTextContent('Slump out of range');
    expect(checklist).toHaveTextContent('Open');
    expect(checklist).toHaveTextContent('arrives with C15');
  });

  it('documents an exception, then Mark reviewed can be sent', async () => {
    let documented = false;
    const fetchMock = renderAt(
      `/concrete/review/${REPORT_ID}`,
      me('rv'),
      reportApi(current, [v1, v2], (url, init) => {
        if (url.endsWith('/versions/2/exception-notes')) {
          if (init?.method === 'POST') documented = true;
          return json(documented && init?.method === 'POST' ? 201 : 200, {
            reportId: REPORT_ID,
            versionNo: 2,
            notes: documented
              ? [
                  {
                    id: '00000000-0000-4000-8000-0000000000f1',
                    versionNo: 2,
                    code: 'slump_out_of_range',
                    field: `readings.${READING_ID}.value`,
                    note: 'Engineer accepted the load',
                    documentedBy: PEOPLE.rv,
                    documentedAt: '2026-11-08T19:00:00.000Z',
                  },
                ]
              : [],
          });
        }
        return undefined;
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Document exception' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a note explaining how it was addressed.',
    );
    await userEvent.type(
      screen.getByLabelText(/How it was addressed/),
      'Engineer accepted the load',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeEnabled(),
    );
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      code: 'slump_out_of_range',
      field: `readings.${READING_ID}.value`,
      note: 'Engineer accepted the load',
    });
    expect(screen.getByText(/Engineer accepted the load/)).toBeInTheDocument();
  });

  it('AC2: Return for correction needs a comment before anything is sent', async () => {
    const fetchMock = renderAt(
      `/concrete/review/${REPORT_ID}`,
      me('rv'),
      reportApi(current, [v1, v2], (url, init) =>
        url.endsWith('/return') && init?.method === 'POST'
          ? json(201, detail({ state: 'returned', allowedActions: [] }))
          : undefined,
      ),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Return for correction' }));
    const dialog = screen.getByRole('dialog', { name: 'Return for correction' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Return report' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Enter a comment explaining the changes needed.',
    );
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/return'))).toBe(false);

    await userEvent.type(within(dialog).getByRole('textbox'), 'Recheck the slump');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Return report' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/return'))).toBe(true),
    );
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/return'))!;
    expect(JSON.parse(String(sent[1]!.body))).toMatchObject({
      version: 4,
      comment: 'Recheck the slump',
    });
  });

  it('the technician sees the actions disabled with who can act', async () => {
    renderAt(
      `/concrete/review/${REPORT_ID}`,
      me('tech'),
      reportApi(detail({ allowedActions: [] }), [versionDetail(1, fields())]),
    );
    const mark = await screen.findByRole('button', { name: 'Mark reviewed' });
    expect(mark).toBeDisabled();
    expect(mark).toHaveAccessibleDescription(
      'You are this report’s technician. Someone else must review it.',
    );
    expect(screen.getByText(/Who can review or return it:/)).toHaveTextContent(
      'a designated reviewer (Riley Reviewer) or the Lead Project Engineer (Pat Example)',
    );
    expect(screen.queryByRole('button', { name: 'Document exception' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('Issue view', () => {
  const reviewedSummary = versionSummary(1, {
    state: 'reviewed',
    review: {
      reviewedBy: PEOPLE.rv,
      reviewedAt: '2026-11-08T19:00:00.000Z',
      source: 'designated_reviewer',
      counted: true,
      clearedAt: null,
    },
  });
  const reviewed = detail({
    state: 'reviewed',
    allowedActions: ['issue', 'return'],
    latest: reviewedSummary,
    warnings: [],
  });
  const version = versionDetail(1, fields(), reviewedSummary, []);

  it('shows the exact version, reviewer, photos unavailable; unset machine info starts as Omit', async () => {
    const fetchMock = renderAt(
      `/concrete/review/${REPORT_ID}/issue`,
      me('js'),
      reportApi(reviewed, [version], (url, init) =>
        url.endsWith('/issue') && init?.method === 'POST' ? json(201, reviewed) : undefined,
      ),
    );
    const side = await screen.findByRole('complementary', { name: 'Issue' });
    expect(side).toHaveTextContent('v1');
    expect(side).toHaveTextContent('Snapshot ab12cd34ef56');
    expect(side).toHaveTextContent('Riley Reviewer');
    const photos = within(side).getByRole('checkbox', { name: 'Include photos' });
    expect(photos).toBeDisabled();
    expect(photos).toHaveAccessibleDescription(/no photos are recorded/);
    await screen.findByText(
      'The project hasn’t set a default, so it’s omitted unless you choose Include.',
    );
    // MM-V2-C38: no forced choice. Unset pre-fills Omit and Issue is available straight away.
    await waitFor(() => expect(within(side).getByRole('radio', { name: 'Omit' })).toBeChecked());
    const issue = within(side).getByRole('button', { name: 'Issue report' });
    expect(issue).toBeEnabled();
    await userEvent.click(issue);
    const dialog = screen.getByRole('dialog', { name: 'Issue this report?' });
    expect(dialog).toHaveTextContent('testing machine information omitted');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Issue report' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/issue'))).toBe(true),
    );
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/issue'))!;
    expect(JSON.parse(String(sent[1]!.body))).toMatchObject({
      version: 4,
      includePhotos: false,
      includeMachineInfo: false,
    });
  });
  it('pre-fills Include from the project setting; the issuer can still override (C38)', async () => {
    const fetchMock = renderAt(
      `/concrete/review/${REPORT_ID}/issue`,
      me('js'),
      reportApi(reviewed, [version], (url, init) => {
        if (url.endsWith('/issue') && init?.method === 'POST') return json(201, reviewed);
        if (url === `/api/projects/${PROJECT_ID}/concrete-settings`) {
          return json(200, {
            projectId: PROJECT_ID,
            defaultSpecimenAges: [7, 28, 28, 'HOLD'],
            holdDurationDays: 56,
            includeMachineInfo: true,
            version: 1,
            updatedAt: null,
            updatedBy: null,
            canEdit: false,
            history: [],
            historyTotal: 0,
          });
        }
        return undefined;
      }),
    );
    const side = await screen.findByRole('complementary', { name: 'Issue' });
    await screen.findByText('Project setting: include.');
    await waitFor(() => expect(within(side).getByRole('radio', { name: 'Include' })).toBeChecked());
    await userEvent.click(within(side).getByRole('radio', { name: 'Omit' }));
    await userEvent.click(within(side).getByRole('button', { name: 'Issue report' }));
    const dialog = screen.getByRole('dialog', { name: 'Issue this report?' });
    expect(dialog).toHaveTextContent('testing machine information omitted');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Issue report' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/issue'))).toBe(true),
    );
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/issue'))!;
    expect(JSON.parse(String(sent[1]!.body))).toMatchObject({ includeMachineInfo: false });
  });
});
