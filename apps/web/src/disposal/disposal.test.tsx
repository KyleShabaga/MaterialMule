import type { MeResponse, RetentionPipeline } from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';
import { decisionUnit, pipeline, pipelineUnit } from './retention-fixtures';
import { disposalTags } from './retention-rows';

// STRATA-90 Retention page: pipeline tabs with the server's counts, bands, tags, the disposal list
// and approvals. Approval never disposes; the server decides everything. Fictional data only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-lm',
  displayName: 'Lee Manager',
  initials: 'LM',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read', 'storage_unit.dispose_scan', 'disposal.approve'],
  sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderAt(
  path: string,
  api: (url: string, init?: RequestInit) => Response,
  user: MeResponse = me(),
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    api(String(input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  pickStationPerson(user);
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

/** Serves the pipeline per tab; everything else gets an empty 200. */
function pipelineApi(
  byTab: Partial<Record<string, RetentionPipeline>>,
  extra?: (url: string, init?: RequestInit) => Response | undefined,
) {
  return (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/retention/pipeline')) {
      const tab = new URL(url, 'http://x').searchParams.get('tab') ?? 'coming';
      const body = byTab[tab];
      return body ? json(200, body) : json(500, {});
    }
    return extra?.(url, init) ?? fallback(url);
  };
}
function fallback(url: string, init?: RequestInit): Response {
  void init;
  if (url.startsWith('/api/me')) return json(200, {});
  return json(200, { items: [], total: 0 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Retention page (STRATA-90)', () => {
  it('Coming up: tab counts from the server, three bands, tags and the tested units apart', async () => {
    const overdue = pipelineUnit(143, { extensionCount: 1 });
    const blocked = pipelineUnit(10, {
      readableId: 'CRE-2026-000010',
      eligible: false,
      programOpen: true,
      requestWaiting: true,
    });
    const month = pipelineUnit(7, {
      readableId: 'CT-2026-000007',
      band: 'month',
      eligible: false,
      effectiveRetainUntil: '2026-11-25',
      hold: { count: 1, holdUntil: '2027-03-31', reason: 'Claim review' },
    });
    const tested = pipelineUnit(4, { readableId: 'ST-2026-000004', band: null, eligible: false });
    renderAt(
      '/disposal-retention',
      pipelineApi({
        coming: pipeline({
          rows: [overdue, blocked, month],
          total: 3,
          tested: [tested],
          counts: { coming: 3, eligible: 1, list: 9, approved: 5, disposed: 214, tested: 1 },
        }),
      }),
    );
    const tabs = await screen.findByRole('tablist', { name: 'Retention stage' });
    expect(within(tabs).getByRole('tab', { name: /On disposal list 9/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: /Disposed 214/ })).toBeInTheDocument();

    const overdueBand = await screen.findByRole('region', { name: 'Overdue' });
    const first = within(overdueBand).getByRole('row', { name: /BKT-2026-000143/ });
    expect(first).toHaveTextContent('Retention ended 2026-11-04 · 7 days ago');
    expect(first).toHaveTextContent('Eligible');
    expect(first).toHaveTextContent('Extended 1×');
    const second = within(overdueBand).getByRole('row', { name: /CRE-2026-000010/ });
    expect(second).toHaveTextContent('Program open');
    expect(second).toHaveTextContent('Request waiting');
    expect(second).not.toHaveTextContent(/Eligible/);

    const monthBand = screen.getByRole('region', { name: 'Within 30 days' });
    expect(monthBand).toHaveTextContent('On hold until 2027-03-31');
    expect(monthBand).not.toHaveTextContent('Eligible');
    expect(
      within(screen.getByRole('region', { name: 'Within 90 days' })).getByText(
        'Nothing in this band.',
      ),
    ).toBeInTheDocument();

    const testedSection = screen.getByRole('region', { name: 'Tested units' });
    expect(testedSection).toHaveTextContent(
      'Retention doesn’t apply. Open each unit and use “Confirm removal after testing”.',
    );
    expect(within(testedSection).getByRole('link', { name: 'Open unit' })).toHaveAttribute(
      'href',
      '/sample-storage/ST-2026-000004',
    );
    // Tested units never sit in the bands.
    expect(overdueBand).not.toHaveTextContent('ST-2026-000004');
  });

  it('STRATA-110 seam: only an eligible Overdue row is tagged Eligible', () => {
    expect(disposalTags(pipelineUnit(1))).toEqual(['Eligible']);
    expect(disposalTags(pipelineUnit(2, { band: 'month', eligible: false }))).toEqual([]);
    expect(disposalTags(pipelineUnit(3, { eligible: false, programOpen: true }))).toEqual([
      'Program open',
    ]);
  });

  it('Decide on a band opens the decision drawer for those units', async () => {
    const a = pipelineUnit(143);
    const b = pipelineUnit(144);
    const fetchMock = renderAt(
      '/disposal-retention',
      pipelineApi(
        {
          coming: pipeline({
            rows: [a, b],
            total: 2,
            bandCounts: { overdue: 2, month: 0, later: 0 },
          }),
        },
        (url) =>
          url.startsWith('/api/retention/decision-units')
            ? json(200, {
                asOf: '2026-11-11',
                projectId: null,
                canRequest: true,
                units: [decisionUnit(143), decisionUnit(144)],
              })
            : undefined,
      ),
    );
    const band = await screen.findByRole('region', { name: 'Overdue' });
    await userEvent.click(within(band).getByRole('button', { name: 'Decide on 2 units' }));
    const drawer = await screen.findByRole('form', {
      name: 'Decide on 2 units at end of retention',
    });
    expect(drawer).toHaveTextContent('Overdue · DEMO-2610');
    const decisionCall = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith('/api/retention/decision-units'),
    );
    expect(String(decisionCall![0])).toContain(`ids=${a.storageUnitId},${b.storageUnitId}`);
  });

  it('On disposal list: grouped by project with the lead; Approve posts the group', async () => {
    const rows = [
      pipelineUnit(61, {
        listEntry: {
          id: 'e1',
          addedBy: { userId: 'u-ss', initials: 'SS', name: 'Sam Sample' },
          addedAt: '2026-11-06T16:00:00.000Z',
          reason: 'Report issued',
        },
      }),
      pipelineUnit(62),
    ];
    const fetchMock = renderAt(
      '/disposal-retention?tab=list',
      pipelineApi({ list: pipeline({ tab: 'list', rows, total: 2 }) }, (url) =>
        url === '/api/disposal/approvals' ? json(201, { batchId: 'b', approvals: [] }) : undefined,
      ),
    );
    const group = await screen.findByRole('region', { name: 'Disposal list DEMO-2610' });
    expect(group).toHaveTextContent('Lead Pat Example');
    expect(group).toHaveTextContent('Sam Sample');
    expect(
      screen.getByText(
        'Approval doesn’t dispose anything; the units stay in stock until scanned out.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(group).getByRole('button', { name: 'Approve 2 units' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Approve 2 units of DEMO-2610 for disposal?',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === '/api/disposal/approvals');
      expect(JSON.parse(String(call![1]!.body)).unitIds).toEqual([
        rows[0]!.storageUnitId,
        rows[1]!.storageUnitId,
      ]);
    });
  });

  it('Approved: Revoke approval needs a reason; they go back on the disposal list', async () => {
    const approval = {
      id: 'a1',
      batchId: 'b1',
      approvedBy: { userId: 'u-pe', initials: 'PE', name: 'Pat Example' },
      approvedAt: '2026-11-09T16:00:00.000Z',
      effectiveRetainUntil: '2026-11-04',
    };
    const fetchMock = renderAt(
      '/disposal-retention?tab=approved',
      pipelineApi(
        {
          approved: pipeline({
            tab: 'approved',
            rows: [pipelineUnit(44, { status: 'approved_for_disposal', approval })],
            total: 1,
          }),
        },
        (url) => (url.includes('/revoke') ? json(200, { id: 'a1' }) : undefined),
      ),
    );
    const group = await screen.findByRole('region', { name: 'Approved DEMO-2610' });
    expect(group).toHaveTextContent('Approved by Pat Example on 2026-11-09');
    expect(group).toHaveTextContent('The scan at the shelf');
    await userEvent.click(within(group).getByRole('button', { name: 'Revoke approval' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('They go back on the disposal list to wait for approval.');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Revoke approval for 1 unit' }),
    );
    expect(
      await within(dialog).findByText('Give a reason. It’s recorded in each unit’s history.'),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/revoke'))).toBe(false);
    await userEvent.type(
      within(dialog).getByLabelText('Reason (required)'),
      'Client wants it kept',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Revoke approval for 1 unit' }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === '/api/disposal/approvals/a1/revoke'),
      ).toBe(true),
    );
  });

  it('nothing approved, and a failed load offers Try again', async () => {
    let fail = true;
    renderAt('/disposal-retention?tab=approved', (url) => {
      if (url.startsWith('/api/retention/pipeline')) {
        if (fail) return json(500, {});
        return json(200, pipeline({ tab: 'approved' }));
      }
      return fallback(url);
    });
    expect(await screen.findByText('Retention couldn’t load.')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing is approved for disposal.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the disposal list' })).toBeInTheDocument();
  });

  it('Disposed is read-only and keeps each ID', async () => {
    renderAt(
      '/disposal-retention?tab=disposed',
      pipelineApi({
        disposed: pipeline({
          tab: 'disposed',
          total: 1,
          rows: [
            pipelineUnit(31, {
              status: 'disposed',
              canDecide: false,
              disposal: {
                disposedAt: '2026-11-10T18:00:00.000Z',
                disposedBy: { userId: 'u-ss', initials: 'SS', name: 'Sam Sample' },
                route: 'standard',
              },
            }),
          ],
        }),
      }),
    );
    const row = await screen.findByRole('row', { name: /BKT-2026-000031/ });
    expect(row).toHaveTextContent('2026-11-10');
    expect(row).toHaveTextContent('Sam Sample');
    expect(
      screen.getByText('Read-only. Each disposed unit keeps its ID and history.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Decide|Revoke|Approve/ })).toBeNull();
  });
});
