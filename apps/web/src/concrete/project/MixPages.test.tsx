import {
  CONCRETE_MIX_SPEC_DEFAULTS,
  type ConcreteMixDetail,
  type ConcreteMixPropagationDecision,
  type ConcreteMixPropagationItem,
  type ConcreteMixPropagationPreview,
  type ConcreteMixPropagationResult,
  type ConcreteMixRevision,
  type ConcreteMixSpec,
  type ProjectDetail,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcreteApiError } from './api';
import { MixDetailPage } from './MixDetailPage';
import { mixPath, propagationPath } from './paths';
import { PropagationReviewPage } from './PropagationReviewPage';

// STRATA-98 (canvas R8Mix*, R8Prop*): the mix page shows the revision in effect beside the draft
// with the changed values marked, and only the project's Lead (as the server reports it) gets
// the edit and approve controls; the change propagation groups records as Can be updated (chosen),
// Your call (not chosen) and Won't change (with why it stays), applies only what is chosen, and
// asks for a reload when the list changed since it was shown. Fictional data only.

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
const applyPropagation =
  vi.fn<
    (id: string, body: ConcreteMixPropagationDecision) => Promise<ConcreteMixPropagationResult>
  >();
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  fetchMix: (id: string) => fetchMix(id),
  fetchPropagation: (id: string) => fetchPropagation(id),
  applyPropagation: (id: string, body: ConcreteMixPropagationDecision) =>
    applyPropagation(id, body),
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

function mixWithDraft(lead: boolean): ConcreteMixDetail {
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
    canManage: lead,
    canApprove: lead,
  } as ConcreteMixDetail;
}

function item(changes: Partial<ConcreteMixPropagationItem>): ConcreteMixPropagationItem {
  return {
    itemId: 'field_report:r1',
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

function preview(
  overrides: Partial<ConcreteMixPropagationPreview> = {},
): ConcreteMixPropagationPreview {
  return {
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
        itemId: 'field_report:r3',
        recordId: 'r3',
        fieldReportId: 'r3',
        recordLabel: 'Field report 2026-11-07, ticket 004460',
        kept: [{ field: 'projectSpec.cementType', before: 'GU', proposed: 'HE' }],
      }),
      item({
        itemId: 'field_report:r2',
        recordId: 'r2',
        fieldReportId: 'r2',
        recordLabel: 'Field report 2026-11-03, ticket 004417',
        reportState: 'submitted',
        eligible: false,
        ineligibleReason: 'report_submitted',
      }),
    ],
    eligibleCount: 2,
    truncated: false,
    canApply: true,
    ...overrides,
  } as ConcreteMixPropagationPreview;
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
  });

  it('shows the revision in effect beside the draft and marks the changed value', async () => {
    fetchMix.mockResolvedValue(mixWithDraft(false));
    renderAt(mixPath(PROJECT.id, MIX_ID));
    expect(await screen.findByRole('heading', { level: 1, name: 'DM-32' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mixes' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Mix specification' });
    expect(
      within(table).getByRole('columnheader', { name: 'Revision 2, in effect' }),
    ).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'Revision 3, draft' })).toBeVisible();
    const changed = table.querySelectorAll('[data-changed="true"]');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toHaveTextContent('100 ± 30 mm, changed');
    expect(changed[0]!.closest('tr')).toHaveTextContent('Slump');
    const status = screen.getByRole('group', { name: 'Mix status' });
    expect(status).toHaveTextContent('Revision pending');
    expect(status).toHaveTextContent('Revision 2 in effect');
    expect(screen.getByRole('region', { name: 'History' })).toBeInTheDocument();
  });

  it('is read-only for someone who isn’t the project’s Lead: no edit or approve controls', async () => {
    fetchMix.mockResolvedValue(mixWithDraft(false));
    renderAt(mixPath(PROJECT.id, MIX_ID));
    await screen.findByRole('heading', { level: 1, name: 'DM-32' });
    expect(
      screen.getByText('Only the project’s lead changes mixes. You can see every revision.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('gives the Lead Approve, Edit draft and More', async () => {
    fetchMix.mockResolvedValue(mixWithDraft(true));
    renderAt(mixPath(PROJECT.id, MIX_ID));
    expect(await screen.findByRole('button', { name: 'Approve revision 3' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Edit draft' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
    expect(
      screen.getByText('Revision 2 stays in effect until you approve revision 3.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Only the project’s lead changes mixes/)).toBeNull();
  });

  it('offers the Lead "Change this mix" on an approved mix, which edits as a new revision', async () => {
    const user = userEvent.setup();
    const mix = mixWithDraft(true);
    fetchMix.mockResolvedValue({
      ...mix,
      status: 'approved',
      draftRevision: null,
      revisions: [mix.effectiveRevision!],
    });
    renderAt(mixPath(PROJECT.id, MIX_ID));
    await user.click(await screen.findByRole('button', { name: 'Change this mix' }));
    expect(screen.getByRole('heading', { name: 'Edit as a new revision' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Edit mix' })).toBeInTheDocument();
  });

  it('says when a mix has no approved revision yet', async () => {
    const mix = mixWithDraft(true);
    fetchMix.mockResolvedValue({
      ...mix,
      status: 'unapproved',
      effectiveRevision: null,
      revisions: [mix.draftRevision!],
    });
    renderAt(mixPath(PROJECT.id, MIX_ID));
    expect(await screen.findByText('This mix has no approved revision yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve revision 3' })).toBeEnabled();
    expect(screen.getByRole('group', { name: 'Mix status' })).toHaveTextContent('Unapproved');
  });
});

describe('change propagation', () => {
  beforeEach(() => {
    fetchPropagation.mockReset();
    applyPropagation.mockReset();
  });

  it('groups records from the server’s eligibility, with Can be updated chosen', async () => {
    fetchPropagation.mockResolvedValue(preview());
    renderAt(propagationPath(PROJECT.id, MIX_ID));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Update records from revision 3' }),
    ).toBeInTheDocument();

    const can = screen.getByRole('region', { name: 'Can be updated' });
    expect(can).toHaveTextContent('Slump target (mm)');
    expect(can).toHaveTextContent('from 80 to 100');
    expect(can.querySelector('s')).toHaveTextContent('80');
    expect(
      within(can).getByRole('checkbox', { name: 'Update Field report 2026-11-06, ticket 004452' }),
    ).toBeChecked();

    const call = screen.getByRole('region', { name: 'Your call' });
    expect(
      within(call).getByRole('checkbox', { name: 'Update Field report 2026-11-07, ticket 004460' }),
    ).not.toBeChecked();
    expect(call).toHaveTextContent('Changed by hand, kept as written');

    const wont = screen.getByRole('region', { name: 'Won’t change' });
    expect(within(wont).queryByRole('checkbox')).toBeNull();
    expect(wont).toHaveTextContent('ticket 004417');
    expect(wont).toHaveTextContent('Why it stays: Submitted: it changes only through review');

    expect(screen.getByRole('button', { name: 'Apply to 1 record' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve all 2' })).toBeEnabled();
  });

  it('applies only the chosen records with the note, then says what was applied', async () => {
    const user = userEvent.setup();
    fetchPropagation.mockResolvedValue(preview());
    applyPropagation.mockResolvedValue({
      appliedItemIds: ['field_report:r1', 'field_report:r3'],
      scope: 'items',
      preview: preview({ previewId: 'pv2', items: [], eligibleCount: 0 }),
    });
    renderAt(propagationPath(PROJECT.id, MIX_ID));
    await user.click(
      await screen.findByRole('checkbox', {
        name: 'Update Field report 2026-11-07, ticket 004460',
      }),
    );
    await user.type(screen.getByLabelText('Note for the mix history'), 'Supplier revised slump');
    await user.click(screen.getByRole('button', { name: 'Apply to 2 records' }));

    expect(applyPropagation).toHaveBeenCalledTimes(1);
    const [mixId, body] = applyPropagation.mock.calls[0]!;
    expect(mixId).toBe(MIX_ID);
    expect(body).toMatchObject({
      previewId: 'pv1',
      selection: { kind: 'items', itemIds: ['field_report:r1', 'field_report:r3'] },
      note: 'Supplier revised slump',
    });
    expect(await screen.findByText('Applied to 2 records')).toBeInTheDocument();
  });

  it('refuses to apply from a list that changed, and asks for a reload', async () => {
    const user = userEvent.setup();
    fetchPropagation.mockResolvedValue(preview());
    applyPropagation.mockRejectedValue(
      new ConcreteApiError(409, 'preview_stale', [], {
        code: 'preview_stale',
        current: preview({ previewId: 'pv2' }),
      }),
    );
    renderAt(propagationPath(PROJECT.id, MIX_ID));
    await user.click(await screen.findByRole('button', { name: 'Apply to 1 record' }));
    expect(await screen.findByText('This list changed since it was shown')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply to 1 record' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve all 2' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reload the list' }));
    expect(screen.queryByText('This list changed since it was shown')).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply to 1 record' })).toBeEnabled();
  });

  it('shows no choices to someone who isn’t the Lead', async () => {
    fetchPropagation.mockResolvedValue(preview({ canApply: false }));
    renderAt(propagationPath(PROJECT.id, MIX_ID));
    expect(
      await screen.findByText(
        'Only the project’s Lead Project Engineer can update records from the mix.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply|Approve all/ })).toBeNull();
  });

  it('says there is nothing to update while the mix has no approved revision', async () => {
    fetchPropagation.mockResolvedValue(
      preview({ toRevisionId: null, toRevisionNumber: null, items: [], eligibleCount: 0 }),
    );
    renderAt(propagationPath(PROJECT.id, MIX_ID));
    expect(
      await screen.findByText(
        'This mix has no approved revision yet, so there is nothing to update.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the mix' })).toHaveAttribute(
      'href',
      mixPath(PROJECT.id, MIX_ID),
    );
  });
});
