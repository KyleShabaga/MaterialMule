import {
  CONCRETE_MIX_SPEC_DEFAULTS,
  type ConcreteMixDetail,
  type ConcreteMixPropagationItem,
  type ConcreteMixPropagationPreview,
  type ConcreteMixRevision,
  type ConcreteMixSpec,
  type ProjectDetail,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MixDetailPage } from './MixDetailPage';
import { mixPath, propagationPath } from './paths';
import { PropagationReviewPage } from './PropagationReviewPage';

// Field Ledger lane F: the mix page shows the approved and draft revisions side by side with the
// draft's changed values marked in text, and "Update open records" strikes the old value through
// beside the new one and lists the records left alone with the reason. Fictional data only.

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Demo tower',
};
const MIX_ID = '00000000-0000-4000-8000-000000000c43';
const PERSON = { userId: 'p1', name: 'Pat Example', initials: 'PE' };

vi.mock('./useProject', () => ({
  useProject: () => ({ project: { ok: true, data: PROJECT as ProjectDetail }, reload: () => {} }),
}));

const fetchMix = vi.fn<(id: string) => Promise<ConcreteMixDetail>>();
const fetchPropagation = vi.fn<(id: string) => Promise<ConcreteMixPropagationPreview>>();
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  fetchMix: (id: string) => fetchMix(id),
  fetchPropagation: (id: string) => fetchPropagation(id),
}));

function spec(changes: Partial<ConcreteMixSpec> = {}): ConcreteMixSpec {
  return {
    ...CONCRETE_MIX_SPEC_DEFAULTS,
    supplierName: 'Example Ready-Mix',
    mixNumber: 'DM-32',
    specifiedStrengthMpa: 32,
    slumpTargetMm: 80,
    slumpToleranceMm: 30,
    testAges: [7, 28, 28, 'HOLD'],
    ...changes,
  } as ConcreteMixSpec;
}

function revision(
  revisionNumber: number,
  state: ConcreteMixRevision['state'],
  s: ConcreteMixSpec,
): ConcreteMixRevision {
  return {
    id: `rev-${revisionNumber}`,
    revisionNumber,
    state,
    spec: s,
    createdAt: '2026-11-01T10:00:00Z',
    createdBy: PERSON,
    updatedAt: '2026-11-01T10:00:00Z',
    approvedAt: state === 'approved' ? '2026-11-02T10:00:00Z' : null,
    approvedBy: state === 'approved' ? PERSON : null,
    supersededAt: null,
    discardedAt: null,
    discardedBy: null,
    missingForApproval: [] as string[],
  };
}

function mixWithDraft(): ConcreteMixDetail {
  const approved = revision(2, 'approved', spec());
  const draft = revision(3, 'draft', spec({ slumpTargetMm: 100 }));
  return {
    id: MIX_ID,
    projectId: PROJECT.id,
    projectNumber: PROJECT.projectNumber,
    supplierName: 'Example Ready-Mix',
    mixNumber: 'DM-32',
    supplier: null,
    status: 'revision_pending',
    effectiveRevision: approved,
    draftRevision: draft,
    copiedFrom: null,
    version: 4,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-03T10:00:00Z',
    revisions: [draft, approved],
    history: [],
    historyTotal: 0,
    canManage: false,
    canApprove: false,
  } as ConcreteMixDetail;
}

function item(changes: Partial<ConcreteMixPropagationItem>): ConcreteMixPropagationItem {
  return {
    itemId: 'report:r1',
    recordType: 'field_report',
    recordId: 'r1',
    recordLabel: 'Field report 2026-11-06, ticket 004452',
    fieldReportId: 'r1',
    reportState: 'draft',
    fromRevisionNumber: 2,
    changes: [{ field: 'projectSpec.slumpTargetMm', before: 80, proposed: 100 }],
    kept: [],
    eligible: true,
    ineligibleReason: null,
    ...changes,
  } as ConcreteMixPropagationItem;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId/concrete/mixes/:mixId" element={<MixDetailPage />} />
        <Route
          path="/projects/:projectId/concrete/mixes/:mixId/propagation"
          element={<PropagationReviewPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the mix page', () => {
  beforeEach(() => {
    fetchMix.mockReset();
    fetchMix.mockResolvedValue(mixWithDraft());
  });

  it('shows both revisions side by side and marks the changed value in text', async () => {
    renderAt(mixPath(PROJECT.id, MIX_ID));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Example Ready-Mix · DM-32' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to Mixes' })).toBeInTheDocument();
    const approved = screen.getByRole('region', { name: 'Revision 2 (in effect)' });
    const draft = screen.getByRole('region', { name: 'Revision 3 (draft)' });
    expect(within(approved).queryByText('Changed')).toBeNull();
    const changed = within(draft).getAllByText('Changed');
    expect(changed).toHaveLength(1);
    const row = changed[0]!.closest('.mix-spec-row')!;
    expect(row).toHaveClass('is-changed');
    expect(row).toHaveTextContent('Slump');
    expect(row).toHaveTextContent('100 ± 30 mm');
    // Not the Lead: no actions, and who can.
    expect(
      screen.getByText('Only the project’s Lead Project Engineer can edit or approve this mix.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('region', { name: 'History' })).toBeInTheDocument();
  });
});

describe('update open records', () => {
  beforeEach(() => {
    fetchPropagation.mockReset();
    fetchPropagation.mockResolvedValue({
      previewId: 'pv1',
      mixId: MIX_ID,
      projectId: PROJECT.id,
      supplierName: 'Example Ready-Mix',
      mixNumber: 'DM-32',
      toRevisionId: 'rev-3',
      toRevisionNumber: 3,
      generatedAt: '2026-11-10T10:00:00Z',
      items: [
        item({}),
        item({
          itemId: 'report:r2',
          recordId: 'r2',
          fieldReportId: 'r2',
          recordLabel: 'Field report 2026-11-03, ticket 004417',
          reportState: 'submitted',
          eligible: false,
          ineligibleReason: 'report_submitted',
        }),
      ],
      eligibleCount: 1,
      truncated: false,
      canApply: true,
    } as ConcreteMixPropagationPreview);
  });

  it('strikes the old value through beside the new one and changes nothing unless chosen', async () => {
    const user = userEvent.setup();
    renderAt(propagationPath(PROJECT.id, MIX_ID));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Update open records' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to the mix' })).toBeInTheDocument();

    const can = screen.getByRole('region', { name: 'Can be updated' });
    expect(can).toHaveTextContent('Slump target (mm)');
    expect(can).toHaveTextContent('from 80 to 100');
    expect(can.querySelector('s')).toHaveTextContent('80');
    const box = within(can).getByRole('checkbox', {
      name: 'Update Field report 2026-11-06, ticket 004452',
    });
    expect(box).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Approve selected (0)' })).toBeDisabled();
    await user.click(box);
    expect(screen.getByRole('button', { name: 'Approve selected (1)' })).toBeEnabled();
    expect(box.closest('tr')).toHaveClass('is-selected');

    const left = screen.getByRole('region', { name: 'Left as they are' });
    expect(within(left).queryByRole('checkbox')).toBeNull();
    expect(left).toHaveTextContent('ticket 004417');
    expect(left).toHaveTextContent('Not a draft');
    expect(left).toHaveTextContent('Submitted: it changes only through review');
  });
});
