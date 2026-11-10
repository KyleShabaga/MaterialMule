import type {
  ConcreteMixDetail,
  ConcreteMixPropagationPreview,
  ProjectDetail,
} from '@materialmule/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MixDetailPage } from './MixDetailPage';
import { mixPath, propagationPath } from './paths';
import { PropagationReviewPage } from './PropagationReviewPage';

// Review fix (PR #142): a URL naming project A with project B's mix must not show B's mix (or its
// edit / approve controls) under A's header; it goes to B's own address. The signed-in Lead leads
// both projects. Fictional projects only.

const A = { id: '00000000-0000-4000-8000-00000000000a', projectNumber: 'DEMO-2601', name: 'Tower' };
const B = {
  id: '00000000-0000-4000-8000-00000000000b',
  projectNumber: 'DEMO-2602',
  name: 'Bridge',
};
const MIX_ID = '00000000-0000-4000-8000-000000000c42';

vi.mock('./useProject', () => ({
  // Project A's header loads; B's stays loading, so nothing renders past the redirect.
  useProject: (projectId: string) => ({
    project: projectId === A.id ? { ok: true, data: A as ProjectDetail } : null,
    reload: () => undefined,
  }),
}));

const fetchMix = vi.fn<(id: string) => Promise<ConcreteMixDetail>>();
const fetchPropagation = vi.fn<(id: string) => Promise<ConcreteMixPropagationPreview>>();
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  fetchMix: (id: string) => fetchMix(id),
  fetchPropagation: (id: string) => fetchPropagation(id),
}));

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
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
      <Where />
    </MemoryRouter>,
  );
}

describe('a mix opened under another project', () => {
  beforeEach(() => {
    fetchMix.mockReset();
    fetchPropagation.mockReset();
    // Only the fields the guard reads: the page must not get as far as rendering the rest.
    fetchMix.mockResolvedValue({
      id: MIX_ID,
      projectId: B.id,
      supplierName: 'Example Ready-Mix',
      mixNumber: 'B-1',
    } as ConcreteMixDetail);
    fetchPropagation.mockResolvedValue({
      mixId: MIX_ID,
      projectId: B.id,
      items: [],
    } as unknown as ConcreteMixPropagationPreview);
  });

  it('the mix page goes to the mix’s own project and shows nothing under A', async () => {
    renderAt(mixPath(A.id, MIX_ID));
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(mixPath(B.id, MIX_ID)),
    );
    expect(fetchMix).toHaveBeenCalledWith(MIX_ID);
    expect(screen.queryByText('DEMO-2601')).toBeNull();
    expect(screen.queryByText(/B-1/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the propagation review goes to the mix’s own project and shows nothing under A', async () => {
    renderAt(propagationPath(A.id, MIX_ID));
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(propagationPath(B.id, MIX_ID)),
    );
    expect(fetchPropagation).toHaveBeenCalledWith(MIX_ID);
    expect(screen.queryByText('DEMO-2601')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
