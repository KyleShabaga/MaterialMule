import {
  concreteReviewChecklist,
  type ConcreteFieldReportDetail,
  type ConcreteReportVersionDetail,
  type ConcreteReviewQueue,
  type MeResponse,
} from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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

/** The last router `renderAt` mounted, to navigate it without unmounting (review fix #144). */
let router: ReturnType<typeof createMemoryRouter>;

function renderAt(path: string, user: MeResponse, api: Api) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return api(url, init) ?? json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  router = createMemoryRouter(routes, { initialEntries: [path] });
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
    openExceptionCount: 0,
    ...overrides,
  });

  const urls = (fetchMock: ReturnType<typeof renderAt>) =>
    fetchMock.mock.calls.map((c) => String(c[0]));

  it('STRATA-97: tabs with counts, each row’s columns, and the exact version it opens', async () => {
    const fetchMock = renderAt('/concrete/review', me('rv'), (url) =>
      url.startsWith('/api/concrete/review-queue')
        ? json(200, queue({ openExceptionCount: 3 }))
        : undefined,
    );
    const table = await screen.findByRole('table', { name: /Waiting for review/ });
    const tabs = screen.getByRole('tablist', { name: 'Queue status' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual([
      'Waiting for review1',
      'Returned2',
      'Reviewed, not issued0',
      'Exceptions3',
      'Issued5',
    ]);
    expect(within(tabs).getByRole('tab', { name: /Waiting for review/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const row = within(table).getAllByRole('row')[1]!;
    // Opens the exact report and version shown.
    expect(within(row).getByRole('link', { name: 'DEMO-2601' })).toHaveAttribute(
      'href',
      `/concrete/review/${REPORT_ID}?version=2`,
    );
    expect(row).toHaveTextContent('Field report');
    expect(row).toHaveTextContent('v2');
    expect(row).toHaveTextContent('2026-11-08');
    expect(row).toHaveTextContent('Alex Tester');
    expect(row).toHaveTextContent('1 open');
    expect(row).toHaveTextContent('Slump out of range');
    expect(row).toHaveTextContent('You');
    expect(row).toHaveTextContent('Your action');
    expect(urls(fetchMock)).toContain(
      '/api/concrete/review-queue?status=awaiting_review&exceptions=any&page=1',
    );
  });

  it('STRATA-97: tabs, filters, search and sort are server filters', async () => {
    const fetchMock = renderAt(
      '/concrete/review?status=open_exceptions&filter=mine&filter=field&sort=project&dir=desc&search=demo',
      me('rv'),
      (url) => (url.startsWith('/api/concrete/review-queue') ? json(200, queue()) : undefined),
    );
    await screen.findByRole('table', { name: /Reports with open exceptions/ });
    await waitFor(() =>
      expect(urls(fetchMock)).toContain(
        '/api/concrete/review-queue?status=open_exceptions&search=demo&exceptions=any&reportType=field&mine=true&sort=project&dir=desc&page=1',
      ),
    );
    // Another tab is another server filter; the search, filters and sort carry over.
    await userEvent.click(screen.getByRole('tab', { name: /Returned/ }));
    await waitFor(() =>
      expect(urls(fetchMock)).toContain(
        '/api/concrete/review-queue?status=returned&search=demo&exceptions=any&reportType=field&mine=true&sort=project&dir=desc&page=1',
      ),
    );
    await userEvent.click(screen.getByRole('tab', { name: /Issued/ }));
    await waitFor(() =>
      expect(urls(fetchMock).at(-1)).toMatch(/^\/api\/concrete\/review-queue\?status=issued&/),
    );
  });

  it('STRATA-97: J/K move between reports in the order shown; Enter opens one', async () => {
    const second = {
      ...queue().items[0]!,
      reportId: '00000000-0000-4000-8000-0000000000b9',
      projectNumber: 'DEMO-2602',
      versionNo: 1,
    };
    renderAt('/concrete/review', me('rv'), (url) =>
      url.startsWith('/api/concrete/review-queue')
        ? json(200, queue({ items: [queue().items[0]!, second], total: 2 }))
        : undefined,
    );
    const table = await screen.findByRole('table', { name: /Waiting for review/ });
    const rows = within(table).getAllByRole('row').slice(1);
    await userEvent.keyboard('j');
    expect(rows[0]).toHaveFocus();
    await userEvent.keyboard('j');
    expect(rows[1]).toHaveFocus();
    await userEvent.keyboard('k');
    expect(rows[0]).toHaveFocus();
    await userEvent.keyboard('j');
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/concrete/review/${second.reportId}`),
    );
    expect(router.state.location.search).toBe('?version=1');
  });

  it('STRATA-97: an empty tab says nothing here needs your action, never that no work exists', async () => {
    renderAt('/concrete/review', me('rv'), (url) =>
      url.startsWith('/api/concrete/review-queue')
        ? json(200, queue({ items: [], total: 0 }))
        : undefined,
    );
    expect(await screen.findByText('Nothing here needs your action.')).toBeVisible();
    expect(screen.getByText(/Only reports on projects you can see are listed/)).toBeVisible();
  });

  it('STRATA-97: a failed load offers Try again', async () => {
    let fail = true;
    renderAt('/concrete/review', me('rv'), (url) => {
      if (!url.startsWith('/api/concrete/review-queue')) return undefined;
      return fail ? json(500, { code: 'internal' }) : json(200, queue());
    });
    expect(await screen.findByText('Couldn’t load the review queue')).toBeVisible();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: /Waiting for review/ })).toBeVisible();
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
    // STRATA-96: labelled as a review preview, never the issued file; no number before issue.
    expect(
      screen.getByText(/Review preview, not the issued file · template P1 is provisional/),
    ).toBeVisible();
    expect(preview).toHaveTextContent('CF number at issue');
    expect(preview).toHaveTextContent('Not issued');
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
    const checklist = screen.getByRole('complementary', { name: 'Review panel' });
    expect(checklist).toHaveTextContent('Slump out of range');
    expect(checklist).toHaveTextContent('Open');
    expect(checklist).toHaveTextContent('arrives with C15');
    // The exception's marker sits on the paper section its field belongs to and links to it.
    const marker = within(preview).getByRole('link', {
      name: 'Exception 1 on Slump and air readings: Slump out of range',
    });
    expect(marker).toHaveAttribute('href', '#exception-1');
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
    await userEvent.click(await screen.findByRole('button', { name: 'Save note' }));
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

  it('review fix #139: a version list behind the detail never enables actions on the shown version', async () => {
    // The list still shows v1 submitted; the detail (read in parallel) already has v2.
    const staleV1 = versionDetail(1, fields(), {}, []);
    const resubmitted = detail({ latest: versionSummary(2), warnings: [] });
    const fetchMock = renderAt(
      `/concrete/review/${REPORT_ID}`,
      me('rv'),
      reportApi(resubmitted, [staleV1]),
    );
    await screen.findByRole('article', { name: /Review preview · version 1/ });
    const mark = screen.getByRole('button', { name: 'Mark reviewed' });
    expect(mark).toBeDisabled();
    expect(mark).toHaveAccessibleDescription('Reload to review the latest version first.');
    expect(screen.getByRole('button', { name: 'Return for correction' })).toBeDisabled();
    // STRATA-96: the report changed while it loaded; Reload is offered.
    expect(screen.getByText('This report changed while it was loading')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();
    // The two reads were retried before giving up on them agreeing.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/versions')).length).toBe(3);
  });

  it('review fix #139: Mark reviewed names the version shown, so the server can refuse another', async () => {
    const clean = versionDetail(1, fields(), {}, []);
    const fetchMock = renderAt(
      `/concrete/review/${REPORT_ID}`,
      me('rv'),
      reportApi(detail({ latest: versionSummary(1), warnings: [] }), [clean], (url, init) =>
        url.endsWith('/review') && init?.method === 'POST'
          ? json(201, detail({ latest: versionSummary(1, { state: 'reviewed' }), warnings: [] }))
          : undefined,
      ),
    );
    const mark = await screen.findByRole('button', { name: 'Mark reviewed' });
    await waitFor(() => expect(mark).toBeEnabled());
    await userEvent.click(mark);
    const dialog = screen.queryByRole('dialog');
    if (dialog) {
      await userEvent.click(within(dialog).getByRole('button', { name: /Mark reviewed/ }));
    }
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/review'))).toBe(true),
    );
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/review'))!;
    expect(JSON.parse(String(sent[1]!.body))).toMatchObject({ version: 4, reportVersionNo: 1 });
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
    // STRATA-96: the comment is asked for at the panel's foot, in place of the decision.
    const panel = screen.getByRole('complementary', { name: 'Review panel' });
    expect(within(panel).queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
    const send = within(panel).getByRole('button', { name: 'Return for correction' });
    await userEvent.click(send);
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Enter a comment explaining the changes needed.',
    );
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/return'))).toBe(false);

    await userEvent.type(
      within(panel).getByRole('textbox', { name: 'Comment for Alex Tester' }),
      'Recheck the slump',
    );
    await userEvent.click(send);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/return'))).toBe(true),
    );
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/return'))!;
    expect(JSON.parse(String(sent[1]!.body))).toMatchObject({
      version: 4,
      reportVersionNo: 2,
      comment: 'Recheck the slump',
    });
  });

  it('self-review denial: the report’s own author gets no reviewer decision at all', async () => {
    const fetchMock = renderAt(
      `/concrete/review/${REPORT_ID}`,
      me('tech'),
      reportApi(detail({ allowedActions: [] }), [versionDetail(1, fields())]),
    );
    const panel = await screen.findByRole('complementary', { name: 'Review panel' });
    expect(within(panel).getByText('You wrote this report')).toBeVisible();
    expect(
      within(panel).getByText(/You can’t review or issue your own report\./),
    ).toHaveTextContent(
      'A designated reviewer (Riley Reviewer) or the Lead Project Engineer (Pat Example) reviews it',
    );
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Return for correction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();
    // The exception is still listed, read-only.
    expect(panel).toHaveTextContent('Slump out of range');
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
  });

  it('someone without review authority sees the decision disabled with who can act', async () => {
    renderAt(
      `/concrete/review/${REPORT_ID}`,
      me('js'),
      reportApi(detail({ allowedActions: [] }), [versionDetail(1, fields())]),
    );
    const mark = await screen.findByRole('button', { name: 'Mark reviewed' });
    expect(mark).toBeDisabled();
    expect(mark).toHaveAccessibleDescription(
      'Only a designated reviewer (Riley Reviewer) or the Lead Project Engineer (Pat Example) can review this report.',
    );
    expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();
  });

  it('stale version conflict: a refused command says so and reloads the report', async () => {
    const clean = versionDetail(1, fields(), {}, []);
    const fetchMock = renderAt(
      `/concrete/review/${REPORT_ID}`,
      me('rv'),
      reportApi(detail({ latest: versionSummary(1), warnings: [] }), [clean], (url, init) =>
        url.endsWith('/review') && init?.method === 'POST'
          ? json(409, { code: 'version_conflict' })
          : undefined,
      ),
    );
    const mark = await screen.findByRole('button', { name: 'Mark reviewed' });
    await waitFor(() => expect(mark).toBeEnabled());
    const reads = () =>
      fetchMock.mock.calls.filter(
        (c) => String(c[0]) === `/api/concrete/field-reports/${REPORT_ID}`,
      ).length;
    const before = reads();
    await userEvent.click(mark);
    expect(
      await screen.findByText(
        'Someone changed this report while you had it open. It has been reloaded; check it and try again.',
      ),
    ).toBeVisible();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
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
    const side = await screen.findByRole('complementary', { name: 'Issue panel' });
    expect(side).toHaveTextContent('v1');
    expect(side).toHaveTextContent('Snapshot ab12cd34ef56');
    expect(side).toHaveTextContent('Riley Reviewer');
    // The CF number is allocated in the issue transaction, never by the preview.
    expect(side).toHaveTextContent('The next CF number, given when you issue');
    expect(screen.getByRole('article', { name: /Review preview · version 1/ })).toHaveTextContent(
      'CF number at issue',
    );
    const photos = within(side).getByRole('switch', { name: 'Include photos' });
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
    const dialog = screen.getByRole('alertdialog', { name: 'Issue the 2026-11-08 field report?' });
    expect(dialog).toHaveTextContent('testing machine information omitted');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Issue report' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/issue'))).toBe(true),
    );
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/issue'))!;
    expect(JSON.parse(String(sent[1]!.body))).toMatchObject({
      version: 4,
      // Review fix #139: bound to the version shown.
      reportVersionNo: 1,
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
    const side = await screen.findByRole('complementary', { name: 'Issue panel' });
    await screen.findByText('Project setting: include.');
    await waitFor(() => expect(within(side).getByRole('radio', { name: 'Include' })).toBeChecked());
    await userEvent.click(within(side).getByRole('radio', { name: 'Omit' }));
    await userEvent.click(within(side).getByRole('button', { name: 'Issue report' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Issue the 2026-11-08 field report?' });
    expect(dialog).toHaveTextContent('testing machine information omitted');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Issue report' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/issue'))).toBe(true),
    );
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/issue'))!;
    expect(JSON.parse(String(sent[1]!.body))).toMatchObject({ includeMachineInfo: false });
  });

  it('review fix #144: moving to another report starts from that project’s setting, not the last choice', async () => {
    const OTHER_REPORT = '00000000-0000-4000-8000-0000000000b2';
    const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000c2';
    const other = { ...reviewed, id: OTHER_REPORT, projectId: OTHER_PROJECT };
    const settings = (projectId: string, includeMachineInfo: boolean) => ({
      projectId,
      defaultSpecimenAges: [7, 28, 28, 'HOLD'],
      holdDurationDays: 56,
      includeMachineInfo,
      version: 1,
      updatedAt: null,
      updatedBy: null,
      canEdit: false,
      history: [],
      historyTotal: 0,
    });
    const versions = (reportId: string) => {
      const { snapshot: _s, reportId: _r, ...summary } = version;
      void _s;
      void _r;
      return { reportId, versions: [summary], transitions: [] };
    };
    const fetchMock = renderAt(`/concrete/review/${REPORT_ID}/issue`, me('js'), (url, init) => {
      for (const [id, body] of [
        [REPORT_ID, reviewed],
        [OTHER_REPORT, other],
      ] as const) {
        const base = `/api/concrete/field-reports/${id}`;
        if (url === base) return json(200, body);
        if (url === `${base}/versions`) return json(200, versions(id));
        if (url === `${base}/versions/1`) return json(200, { ...version, reportId: id });
        if (url === `${base}/versions/1/exception-notes`) {
          return json(200, { reportId: id, versionNo: 1, notes: [] });
        }
        if (url === `${base}/issue` && init?.method === 'POST') return json(201, body);
      }
      // A includes machine information; the other project omits it.
      if (url === `/api/projects/${PROJECT_ID}/concrete-settings`) {
        return json(200, settings(PROJECT_ID, true));
      }
      if (url === `/api/projects/${OTHER_PROJECT}/concrete-settings`) {
        return json(200, settings(OTHER_PROJECT, false));
      }
      return undefined;
    });
    await screen.findByText('Project setting: include.');
    let side = screen.getByRole('complementary', { name: 'Issue panel' });
    await waitFor(() => expect(within(side).getByRole('radio', { name: 'Include' })).toBeChecked());

    await act(() => router.navigate(`/concrete/review/${OTHER_REPORT}/issue`));
    await screen.findByText('Project setting: omit.');
    side = screen.getByRole('complementary', { name: 'Issue panel' });
    await waitFor(() => expect(within(side).getByRole('radio', { name: 'Omit' })).toBeChecked());
    await userEvent.click(within(side).getByRole('button', { name: 'Issue report' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Issue the 2026-11-08 field report?' });
    expect(dialog).toHaveTextContent('testing machine information omitted');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Issue report' }));
    const issued = `/api/concrete/field-reports/${OTHER_REPORT}/issue`;
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === issued)).toBe(true),
    );
    const sent = fetchMock.mock.calls.find((c) => String(c[0]) === issued)!;
    expect(JSON.parse(String(sent[1]!.body))).toMatchObject({ includeMachineInfo: false });
  });

  it('issue confirm: nothing is sent until the irreversible confirm; Cancel sends nothing', async () => {
    const fetchMock = renderAt(
      `/concrete/review/${REPORT_ID}/issue`,
      me('js'),
      reportApi(reviewed, [version], (url, init) =>
        url.endsWith('/issue') && init?.method === 'POST' ? json(201, reviewed) : undefined,
      ),
    );
    const side = await screen.findByRole('complementary', { name: 'Issue panel' });
    const issue = within(side).getByRole('button', { name: 'Issue report' });
    await waitFor(() => expect(issue).toBeEnabled());
    await userEvent.click(issue);
    const confirm = screen.getByRole('alertdialog', { name: 'Issue the 2026-11-08 field report?' });
    expect(confirm).toHaveTextContent('This can’t be undone');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/issue'))).toBe(false);
  });

  it('an issued report shows As issued; a revision never changes the issued version', async () => {
    const issuedSummary = versionSummary(1, {
      state: 'issued',
      review: reviewedSummary.review,
      issued: {
        by: PEOPLE.js,
        at: '2026-11-09T17:00:00.000Z',
        source: 'report_issuer',
        includePhotos: false,
        includeMachineInfo: false,
        reportNumber: 'CF-2026-00014',
        file: null,
      },
    });
    const issuedDetail = detail({
      state: 'issued',
      allowedActions: ['revise'],
      latest: issuedSummary,
      warnings: [],
    });
    const fetchMock = renderAt(
      `/concrete/review/${REPORT_ID}/issue`,
      me('js'),
      reportApi(issuedDetail, [versionDetail(1, fields(), issuedSummary, [])], (url, init) =>
        url.endsWith('/revise') && init?.method === 'POST'
          ? json(201, detail({ state: 'draft', allowedActions: [], latest: issuedSummary }))
          : undefined,
      ),
    );
    const side = await screen.findByRole('complementary', { name: 'Issue panel' });
    expect(within(side).getByRole('heading', { name: 'As issued' })).toBeVisible();
    expect(within(side).getByText('CF-2026-00014')).toBeVisible();
    expect(screen.getByRole('article', { name: /Review preview · version 1/ })).toHaveTextContent(
      'CF-2026-00014',
    );
    expect(within(side).queryByRole('button', { name: 'Issue report' })).toBeNull();
    await userEvent.click(within(side).getByRole('button', { name: 'Start a revision' }));
    const dialog = screen.getByRole('dialog', { name: 'Start a revision' });
    await userEvent.type(within(dialog).getByRole('textbox'), 'Wrong truck number');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start revision' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/revise'))).toBe(true),
    );
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/revise'))!;
    expect(JSON.parse(String(sent[1]!.body))).toMatchObject({ comment: 'Wrong truck number' });
  });
});
