import type {
  ConcreteSummaryReport,
  ConcreteSummaryReportList,
  ProjectDetail,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SummaryTab } from './SummaryTab';

// MM-V2-C32: the project Concrete → Summary tab's Generate summary report button (C30 left it
// disabled). Fictional project and people only.

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Example tower',
} as ProjectDetail;

const ISSUED: ConcreteSummaryReport = {
  id: '00000000-0000-4000-8000-000000000c32',
  reportNumber: 'CSR-2026-0004',
  issuedAt: '2026-11-09T18:30:00.000Z',
  issuedBy: { userId: '00000000-0000-4000-8000-000000000101', name: 'Pat Example' },
  filters: { from: null, to: null, element: null, mixId: null, mixNumber: null },
  totals: { sets: 3, allIssued: 0, pending: 3 },
  file: {
    id: '00000000-0000-4000-8000-000000000f01',
    kind: 'summary',
    reportNumber: 'CSR-2026-0004',
    revisionNo: 0,
    supersedesFileId: null,
    fileName: 'CSR-2026-0004.pdf',
    mediaType: 'application/pdf',
    byteSize: 2048,
    sha256: 'a'.repeat(64),
    template: {
      id: '00000000-0000-4000-8000-000c32000003',
      kind: 'summary',
      revision: 'P1',
      name: 'Summary report template',
      provisional: true,
    },
    includePhotos: false,
    includeMachineInfo: false,
    createdAt: '2026-11-09T18:30:00.000Z',
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stub(
  list: () => ConcreteSummaryReportList,
  onPost: (body: Record<string, unknown>) => Response,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.endsWith('/summary-reports')) {
      return onPost(JSON.parse(String(init?.body)) as Record<string, unknown>);
    }
    if (url.includes('/summary-reports')) return json(200, list());
    if (url.includes('/concrete-mixes')) {
      return json(200, { items: [], total: 0, page: 1, pageSize: 50, canManage: false });
    }
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Summary tab (MM-V2-C32)', () => {
  it('keeps Generate disabled with the reason for someone without report.issue; Preview still opens', async () => {
    stub(
      () => ({ projectId: PROJECT.id, items: [], canIssue: false }),
      () => json(403, { code: 'forbidden' }),
    );
    render(<SummaryTab project={PROJECT} />);
    expect(
      await screen.findByText(
        'Only the project’s Lead Project Engineer or an Authorized report issuer can issue a summary report.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate summary report' })).toBeDisabled();
    const preview = screen.getByRole('link', { name: 'Preview summary report' });
    expect(preview).toHaveAttribute(
      'href',
      `/api/concrete/projects/${PROJECT.id}/summary-reports/preview`,
    );
    expect(
      screen.getByText('No summary report has been issued for this project.'),
    ).toBeInTheDocument();
  });

  it('issues with the chosen range after confirming, then lists the stored file', async () => {
    let issued = false;
    const posts: Record<string, unknown>[] = [];
    stub(
      () => ({ projectId: PROJECT.id, items: issued ? [ISSUED] : [], canIssue: true }),
      (body) => {
        posts.push(body);
        issued = true;
        return json(201, ISSUED);
      },
    );
    const user = userEvent.setup();
    render(<SummaryTab project={PROJECT} />);
    const generate = await screen.findByRole('button', { name: 'Generate summary report' });
    await screen.findByText('No summary report has been issued for this project.');
    expect(generate).toBeEnabled();

    await user.click(screen.getByRole('radio', { name: 'Between dates' }));
    await user.type(screen.getByLabelText('From'), '2026-11-01');
    await user.type(screen.getByLabelText('To'), '2026-11-30');
    expect(screen.getByRole('link', { name: 'Preview summary report' })).toHaveAttribute(
      'href',
      `/api/concrete/projects/${PROJECT.id}/summary-reports/preview?from=2026-11-01&to=2026-11-30`,
    );

    await user.click(generate);
    const dialog = await screen.findByRole('dialog', { name: 'Issue this summary report?' });
    await user.click(within(dialog).getByRole('button', { name: 'Issue summary report' }));
    expect(await screen.findByText('CSR-2026-0004 issued.')).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      filters: { from: '2026-11-01', to: '2026-11-30', element: null, mixId: null },
    });
    expect(posts[0]!.idempotencyKey).toEqual(expect.any(String));
    const open = await screen.findByRole('link', { name: 'Open CSR-2026-0004 (PDF)' });
    expect(open).toHaveAttribute('href', `/api/concrete/report-files/${ISSUED.file.id}`);
  });

  it('refuses an end date before the start date before anything is sent', async () => {
    const fetchMock = stub(
      () => ({ projectId: PROJECT.id, items: [], canIssue: true }),
      () => json(201, ISSUED),
    );
    const user = userEvent.setup();
    render(<SummaryTab project={PROJECT} />);
    await screen.findByText('No summary report has been issued for this project.');
    await user.click(screen.getByRole('radio', { name: 'Between dates' }));
    await user.type(screen.getByLabelText('From'), '2026-11-30');
    await user.type(screen.getByLabelText('To'), '2026-11-01');
    expect(screen.getByRole('alert')).toHaveTextContent('The end date is before the start date.');
    expect(screen.getByRole('button', { name: 'Generate summary report' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview summary report' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
