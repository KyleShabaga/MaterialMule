import type { DisposalReady } from '@materialmule/shared';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchReady } from './api';
import { ReadyForDisposal } from './ReadyForDisposal';

// MISC-13 review fix: a page that falls past the end after the list shrinks moves to the last
// real page instead of showing a false empty state. Every request is held until the test releases
// it, so the order of responses is explicit (no timing). Fictional data only.

vi.mock('./api', () => ({ fetchReady: vi.fn() }));

const PAGE_SIZE = 50;

interface Pending {
  page: number;
  resolve: (value: DisposalReady | null) => void;
}

let pending: Pending[];

function unit(n: number): DisposalReady['units'][number] {
  return {
    storageUnitId: `u${n}`,
    readableId: `BKT-2026-${String(n).padStart(6, '0')}`,
    unitType: 'bucket',
    project: { id: 'p1', projectNumber: 'DEMO-2601', name: 'Fictional project' },
    location: { code: 'WH-D1', name: 'Warehouse D1 (long-term)' },
    effectiveRetainUntil: '2027-10-23',
    stage: 'awaiting_approval',
    reason: { code: 'retention_ended', label: 'Retention ended 2027-10-23' },
    canApprove: true,
  };
}

/** The server's answer for `page` when `total` units are ready (empty past the end). */
function answer(page: number, total: number): DisposalReady {
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, page * PAGE_SIZE);
  const units = [];
  for (let n = first; n <= last; n += 1) units.push(unit(n));
  return { asOf: '2027-10-24', units, total, page, pageSize: PAGE_SIZE };
}

/** Releases the oldest held request for `page` with `total` ready units. */
async function release(page: number, total: number) {
  const index = pending.findIndex((request) => request.page === page);
  expect(index, `a request for page ${page} is waiting`).toBeGreaterThanOrEqual(0);
  const [request] = pending.splice(index, 1);
  await act(async () => {
    request!.resolve(answer(page, total));
    await Promise.resolve();
  });
}

const requestedPages = () => vi.mocked(fetchReady).mock.calls.map(([page]) => page ?? 1);

function renderList(refresh = 0) {
  const view = render(
    <MemoryRouter>
      <ReadyForDisposal refresh={refresh} />
    </MemoryRouter>,
  );
  return {
    card: () => screen.getByRole('region', { name: 'Ready for disposal' }),
    refresh: (next: number) =>
      view.rerender(
        <MemoryRouter>
          <ReadyForDisposal refresh={next} />
        </MemoryRouter>,
      ),
  };
}

const EMPTY = 'No storage units are ready for disposal right now.';

describe('Ready for disposal paging (MISC-13)', () => {
  beforeEach(() => {
    pending = [];
    vi.mocked(fetchReady).mockImplementation(
      (page = 1) =>
        new Promise<DisposalReady | null>((resolve) => {
          pending.push({ page, resolve });
        }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.mocked(fetchReady).mockReset();
  });

  it('51 ready becoming 50 while on page 2 shows page 1, not an empty list', async () => {
    const user = userEvent.setup();
    const list = renderList();
    await release(1, 51);
    await user.click(within(list.card()).getByRole('button', { name: 'Next' }));
    await release(2, 51);
    expect(within(list.card()).getByRole('link', { name: 'BKT-2026-000051' })).toBeVisible();

    list.refresh(1);
    await release(2, 50);
    // Out of range: nothing changes on screen until page 1 arrives.
    expect(within(list.card()).queryByText(EMPTY)).toBeNull();
    await release(1, 50);

    const card = list.card();
    expect(within(card).getByRole('link', { name: 'BKT-2026-000001' })).toBeVisible();
    expect(within(card).getAllByRole('row')).toHaveLength(51); // header + 50
    expect(within(card).queryByText(EMPTY)).toBeNull();
    expect(within(card).getByLabelText('Ready count')).toHaveTextContent('50 units');
    // Everything fits on one page now, so there is no pager to get stuck on.
    expect(within(card).queryByRole('navigation')).toBeNull();
    expect(requestedPages()).toEqual([1, 2, 2, 1]);
    expect(pending).toHaveLength(0);
  });

  it('a larger shrink moves from page 4 to the new last page', async () => {
    const user = userEvent.setup();
    const list = renderList();
    await release(1, 160);
    for (const next of [2, 3, 4]) {
      await user.click(within(list.card()).getByRole('button', { name: 'Next' }));
      await release(next, 160);
    }
    expect(within(list.card()).getByText('Page 4 of 4')).toBeVisible();

    list.refresh(1);
    await release(4, 60);
    await release(2, 60);

    const card = list.card();
    expect(within(card).getByText('Page 2 of 2')).toBeVisible();
    expect(within(card).getByRole('link', { name: 'BKT-2026-000060' })).toBeVisible();
    expect(within(card).getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(requestedPages()).toEqual([1, 2, 3, 4, 4, 2]);
    expect(pending).toHaveLength(0);
  });

  it('shows the true empty state once nothing is ready, after one corrective load', async () => {
    const user = userEvent.setup();
    const list = renderList();
    await release(1, 51);
    await user.click(within(list.card()).getByRole('button', { name: 'Next' }));
    await release(2, 51);

    list.refresh(1);
    await release(2, 0);
    await release(1, 0);

    const card = list.card();
    expect(within(card).getByText(EMPTY)).toBeVisible();
    expect(within(card).getByLabelText('Ready count')).toHaveTextContent('0 units');
    expect(within(card).queryByRole('navigation')).toBeNull();
    expect(requestedPages()).toEqual([1, 2, 2, 1]);
    expect(pending).toHaveLength(0);
  });

  it('ignores a page response that arrives after moving to another page', async () => {
    const user = userEvent.setup();
    const list = renderList();
    await release(1, 120);
    await user.click(within(list.card()).getByRole('button', { name: 'Next' }));
    await release(2, 120);
    expect(within(list.card()).getByText('Page 2 of 3')).toBeVisible();

    // Page 3 is still loading when the user goes back to page 1.
    await user.click(within(list.card()).getByRole('button', { name: 'Next' }));
    await user.click(within(list.card()).getByRole('button', { name: 'Previous' }));
    expect(requestedPages()).toEqual([1, 2, 3, 1]);
    await release(1, 120);
    // The page 3 answer comes back last and must not replace page 1.
    await release(3, 120);

    const card = list.card();
    expect(within(card).getByText('Page 1 of 3')).toBeVisible();
    expect(within(card).getByRole('link', { name: 'BKT-2026-000001' })).toBeVisible();
    expect(within(card).queryByRole('link', { name: 'BKT-2026-000101' })).toBeNull();
    expect(pending).toHaveLength(0);
  });

  it('ignores an older refresh that completes after a corrective load started', async () => {
    const user = userEvent.setup();
    const list = renderList();
    await release(1, 51);
    await user.click(within(list.card()).getByRole('button', { name: 'Next' }));
    await release(2, 51);

    list.refresh(1); // first refresh of page 2: held
    list.refresh(2); // second refresh of page 2: the one that counts
    expect(requestedPages()).toEqual([1, 2, 2, 2]);
    // The newer refresh answers first: the list shrank to 50, so page 2 is out of range.
    const newer = pending.findLastIndex((request) => request.page === 2);
    const [second] = pending.splice(newer, 1);
    await act(async () => {
      second!.resolve(answer(2, 50));
      await Promise.resolve();
    });
    expect(requestedPages()).toEqual([1, 2, 2, 2, 1]);

    // The older refresh still has the pre-shrink page 2 (unit 51); it must be dropped.
    await release(2, 51);
    await release(1, 50);

    const card = list.card();
    expect(within(card).queryByRole('link', { name: 'BKT-2026-000051' })).toBeNull();
    expect(within(card).getByRole('link', { name: 'BKT-2026-000001' })).toBeVisible();
    expect(within(card).queryByText(EMPTY)).toBeNull();
    expect(pending).toHaveLength(0);
  });
});
