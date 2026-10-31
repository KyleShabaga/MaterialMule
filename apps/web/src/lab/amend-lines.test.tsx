import type { LabProgram, ProgramWork, TestCatalogue } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmendProgram } from './AmendmentControls';

// MM-T83: "Add a testing line" on a submitted program. The preview is the amend route's own
// 409 `coverage_changed` answer; the line is added only when the person confirms it. Fictional
// data only (DEMO-2601, TH26-01).

const PROJECT = '00000000-0000-4000-8000-000000000201';
const HOLE = '00000000-0000-4000-8000-000000000301';
const TICKED = '00000000-0000-4000-8000-000000000401';
const UNTICKED = '00000000-0000-4000-8000-000000000402';
const LATER = '00000000-0000-4000-8000-000000000403';
const MC = '00000000-0000-4000-8000-0000000000a1';
const PROBE = '00000000-0000-4000-8000-000000000000';

const program = {
  id: '00000000-0000-4000-8000-0000000000e1',
  project: { id: PROJECT, projectNumber: 'DEMO-2601', name: 'Riverbank investigation' },
  lines: [{ id: 'line-1', lineNumber: 1, requests: [] }],
} as unknown as LabProgram;

const work = (canAmend: boolean) =>
  ({
    lifecycle: { canAmend, version: 4, amendments: [], identityRevisions: [] },
  }) as unknown as ProgramWork;

const catalogue: TestCatalogue = {
  groups: [{ id: 'soils', name: 'Soils', sortOrder: 1, version: 1, subgroups: [] }],
  tests: [
    {
      id: MC,
      groupId: 'soils',
      groupName: 'Soils',
      subgroupId: null,
      subgroupName: null,
      code: 'DEMO-MC',
      name: 'Moisture Content',
      description: 'Moisture content of soil (fictional)',
      sortOrder: 0,
      active: true,
      retiredAt: null,
      version: 1,
      sampleTagMode: 'none',
      sampleTagGroup: null,
    },
  ],
};

const unit = (id: string, readableId: string) => ({
  storageUnitId: id,
  readableId,
  unitType: 'bucket',
  contents: 'TH26-01: G1–G3',
  receivedDate: '2026-10-20',
});

const covered = (id: string, readableId: string, included: boolean) => ({
  ...unit(id, readableId),
  receiptId: 'r1',
  included,
  matchingBasis: included ? 'reviewed_included' : 'unknown_classification_excluded',
  amendmentId: null,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** `amend` answers each POST in turn; everything else is the catalogue and TH26-01's units. */
function stubFetch(amend: Response[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/amend') && init?.method === 'POST') return amend.shift()!;
    if (url.startsWith('/api/test-catalogue')) return json(200, catalogue);
    if (url.startsWith('/api/test-templates')) return json(200, []);
    if (url.endsWith('/units')) {
      // The server offers only available units: a destroyed or disposed tube is never listed.
      return json(200, [unit(TICKED, 'BKT-2026-000101'), unit(UNTICKED, 'BKT-2026-000102')]);
    }
    if (url.includes('/lab-sources')) {
      return json(200, [{ kind: 'test_hole', id: HOLE, label: 'TH26-01', unitCount: 2 }]);
    }
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const amendBodies = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/amend') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init!.body)));

async function fillGrabsLine(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Amend program' }));
  await user.click(screen.getByRole('button', { name: 'Add a testing line' }));
  const card = await screen.findByRole('region', { name: 'New line 2' });
  await user.selectOptions(within(card).getByLabelText('Sampling source'), 'TH26-01 — 2 units');
  await user.click(within(card).getByLabelText('All grabs (G)'));
  await user.click(await within(card).findByRole('checkbox', { name: /BKT-2026-000101/ }));
  await user.type(within(card).getByLabelText('Find a test'), 'DEMO-MC');
  await user.click(within(card).getByRole('button', { name: /DEMO-MC/ }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Add a testing line (MM-T83)', () => {
  it('AC3: without lab_program.amend (LAB) there is no amend or add-line control', () => {
    stubFetch([]);
    render(<AmendProgram program={program} work={work(false)} onDone={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Amend program' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a testing line' })).not.toBeInTheDocument();
  });

  it('AC1/AC2: previews a Grabs line with explicit units from the 409 answer, then adds it', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    const fetchMock = stubFetch([
      json(409, {
        code: 'coverage_changed',
        lines: [
          {
            index: 0,
            coverage: [
              covered(TICKED, 'BKT-2026-000101', true),
              covered(UNTICKED, 'BKT-2026-000102', false),
            ],
          },
        ],
      }),
      json(201, { programId: program.id, amendmentId: 'a1', version: 5 }),
    ]);
    render(<AmendProgram program={program} work={work(true)} onDone={onDone} />);
    await fillGrabsLine(user);
    expect(screen.queryByRole('button', { name: 'Add line 2' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Preview line' }));
    const preview = await screen.findByRole('region', { name: 'Preview of new line 2' });
    expect(preview).toHaveTextContent('Covers BKT-2026-000101 received so far.');
    expect(preview).toHaveTextContent(
      '1 unit with unknown G/S classification excluded (BKT-2026-000102)',
    );
    expect(onDone).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Add line 2' }));
    expect(onDone).toHaveBeenCalledWith(null);
    const [probe, confirmed] = amendBodies(fetchMock);
    expect(probe).toMatchObject({
      version: 4,
      addLines: [
        {
          source: { kind: 'test_hole', id: HOLE },
          scope: 'grabs',
          identity: null,
          testTypeIds: [MC],
          unitIds: [TICKED],
          reviewedCoverageUnitIds: [PROBE],
        },
      ],
    });
    expect(confirmed.addLines[0]).toMatchObject({
      unitIds: [TICKED],
      reviewedCoverageUnitIds: [TICKED],
    });
    expect(confirmed.idempotencyKey).not.toBe(probe.idempotencyKey);
  });

  it('shows the new coverage when the material changed after the preview, and changing the line clears the preview', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    const coverage = (extra: ReturnType<typeof covered>[]) =>
      json(409, {
        code: 'coverage_changed',
        lines: [{ index: 0, coverage: [covered(TICKED, 'BKT-2026-000101', true), ...extra] }],
      });
    stubFetch([coverage([]), coverage([covered(LATER, 'BKT-2026-000103', false)])]);
    render(<AmendProgram program={program} work={work(true)} onDone={onDone} />);
    await fillGrabsLine(user);
    await user.click(screen.getByRole('button', { name: 'Preview line' }));
    await screen.findByRole('region', { name: 'Preview of new line 2' });

    await user.click(screen.getByRole('button', { name: 'Add line 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed since the preview/);
    expect(screen.getByRole('region', { name: 'Preview of new line 2' })).toHaveTextContent(
      'BKT-2026-000103',
    );
    expect(onDone).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: /BKT-2026-000102/ }));
    expect(screen.queryByRole('region', { name: 'Preview of new line 2' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview line' })).toBeEnabled();
  });
});
