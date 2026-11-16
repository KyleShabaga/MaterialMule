import type { RetentionDecisionUnits } from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decisionUnit } from '../disposal/retention-fixtures';
import { RetentionDecisionDrawer } from './RetentionDecisionDrawer';

// STRATA-91 decision drawer: units all ticked with effective and minimum retain-until; Extend,
// Place a hold, Add to disposal list; reason required; a unit that can't go on the list is
// unticked and disabled with the reason; requesters only send a request. Fictional data only.

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stub(units: RetentionDecisionUnits, post: (url: string, body: unknown) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/retention/decision-units')) return json(200, units);
    return post(url, JSON.parse(String(init?.body ?? '{}')));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posted = (fetchMock: ReturnType<typeof stub>, path: string) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === path)
    .map(([, init]) => JSON.parse(String(init?.body)));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const units = (overrides: Partial<RetentionDecisionUnits> = {}): RetentionDecisionUnits => ({
  asOf: '2026-11-11',
  projectId: null,
  canRequest: true,
  units: [
    decisionUnit(143, { minimumRetainUntil: '2026-05-04', effectiveRetainUntil: '2026-11-04' }),
    decisionUnit(144),
    decisionUnit(145),
    decisionUnit(10, {
      readableId: 'CRE-2026-000010',
      version: 3,
      listBlockers: [{ code: 'program_open', label: 'Program LP-2026-0011 open' }],
    }),
  ],
  ...overrides,
});

describe('Retention decision drawer (STRATA-91)', () => {
  it('lists every unit ticked with both dates; Extend repeats the count; a reason is required', async () => {
    const fetchMock = stub(units(), () =>
      json(200, { action: 'extend', done: [], created: [], failed: [] }),
    );
    const onDone = vi.fn();
    render(
      <RetentionDecisionDrawer
        open
        onOpenChange={() => undefined}
        unitIds={['a', 'b']}
        context="Overdue · DEMO-2610"
        onDone={onDone}
      />,
    );
    const form = await screen.findByRole('form', { name: 'Decide on 4 units at end of retention' });
    expect(form).toHaveTextContent('Overdue · DEMO-2610');
    expect(form).toHaveTextContent('Lead Pat Example');
    const row = within(form).getByRole('row', { name: /BKT-2026-000143/ });
    expect(row).toHaveTextContent('2026-11-04');
    expect(row).toHaveTextContent('2026-05-04');
    expect(within(form).getByText('4 of 4 ticked')).toBeInTheDocument();

    await userEvent.click(within(form).getByRole('checkbox', { name: 'Include BKT-2026-000144' }));
    const primary = within(form).getByRole('button', { name: 'Extend 3 units' });
    await userEvent.click(primary);
    expect(
      await within(form).findByText('Give a reason. It’s recorded in each unit’s history.'),
    ).toBeInTheDocument();
    expect(posted(fetchMock, '/api/retention/decisions')).toEqual([]);

    await userEvent.type(within(form).getByLabelText('Reason (required)'), 'Design review');
    await userEvent.click(primary);
    await waitFor(() => expect(posted(fetchMock, '/api/retention/decisions')).toHaveLength(1));
    const body = posted(fetchMock, '/api/retention/decisions')[0];
    expect(body).toMatchObject({ action: 'extend', extendMonths: 6, reason: 'Design review' });
    expect(body.units).toHaveLength(3);
    expect(body.units).toContainEqual({ id: decisionUnit(10).storageUnitId, version: 3 });
  });

  it('a long list folds behind its count so the choice stays in view', async () => {
    stub(units({ units: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => decisionUnit(n)) }), () =>
      json(200, {}),
    );
    render(<RetentionDecisionDrawer open onOpenChange={() => undefined} unitIds={['a']} />);
    const form = await screen.findByRole('form', { name: 'Decide on 8 units at end of retention' });
    expect(within(form).queryByRole('table', { name: 'Units to decide on' })).toBeNull();
    expect(within(form).getByText('8 of 8 ticked')).toBeInTheDocument();
    expect(within(form).getByRole('radiogroup', { name: 'Decision' })).toBeInTheDocument();
    const show = within(form).getByRole('button', { name: 'Show the 8 units' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(show);
    expect(within(form).getByRole('table', { name: 'Units to decide on' })).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Hide the units' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('Extend says when units keep their date already or would still be due', async () => {
    stub(
      units({
        units: [
          // Minimum 2025-01-10: six months is 2025-07-10, still due on 2026-11-11.
          decisionUnit(1, { minimumRetainUntil: '2025-01-10', effectiveRetainUntil: '2025-01-10' }),
          // Already kept until 2028: an extension changes nothing for it.
          decisionUnit(2, { minimumRetainUntil: '2026-05-01', effectiveRetainUntil: '2028-01-01' }),
        ],
      }),
      () => json(200, {}),
    );
    render(<RetentionDecisionDrawer open onOpenChange={() => undefined} unitIds={['a']} />);
    const form = await screen.findByRole('form', { name: 'Decide on 2 units at end of retention' });
    expect(within(form).getByRole('status', { name: '' })).toHaveTextContent(
      '1 unit already keeps until that date or later, so nothing changes for it. 1 unit would still be due on 2026-11-11. Add more months or choose a later date.',
    );
    const monthsBox = within(form).getByLabelText('Months past the minimum');
    await userEvent.clear(monthsBox);
    await userEvent.type(monthsBox, '60');
    expect(within(form).queryByText(/would still be due/)).toBeNull();
  });

  it('Add to disposal list: a unit that can’t go on it is unticked, disabled and says why', async () => {
    stub(units(), () => json(200, { action: 'dispose', done: [], created: [], failed: [] }));
    render(
      <RetentionDecisionDrawer
        open
        onOpenChange={() => undefined}
        unitIds={['a']}
        initialChoice="dispose"
      />,
    );
    const form = await screen.findByRole('form', { name: /Decide on 4 units/ });
    const locked = within(form).getByRole('row', { name: /CRE-2026-000010/ });
    expect(within(locked).queryByRole('checkbox')).toBeNull();
    expect(locked).toHaveTextContent('Can’t go on the list: Program LP-2026-0011 open');
    expect(within(form).getByText(/3 are eligible/)).toBeInTheDocument();
    expect(
      within(form).getByRole('button', { name: 'Add 3 units to the disposal list' }),
    ).toBeInTheDocument();
  });

  it('shows each unit the server refused and keeps the drawer open', async () => {
    stub(units({ units: [decisionUnit(1), decisionUnit(2)] }), () =>
      json(200, {
        action: 'extend',
        done: [{ storageUnitId: decisionUnit(1).storageUnitId, readableId: 'BKT-2026-000001' }],
        created: [{ id: 'x', projectId: 'p1' }],
        failed: [
          {
            storageUnitId: decisionUnit(2).storageUnitId,
            readableId: 'BKT-2026-000002',
            code: 'retain_until_too_early',
            message: 'Its retain-until is already 2029-01-31; an extension can only make it later.',
          },
        ],
      }),
    );
    const onOpenChange = vi.fn();
    render(<RetentionDecisionDrawer open onOpenChange={onOpenChange} unitIds={['a', 'b']} />);
    const form = await screen.findByRole('form', { name: /Decide on 2 units/ });
    await userEvent.type(within(form).getByLabelText('Reason (required)'), 'Keep');
    await userEvent.click(within(form).getByRole('button', { name: 'Extend 2 units' }));
    expect(await within(form).findByText('1 unit wasn’t changed.')).toBeInTheDocument();
    expect(form).toHaveTextContent('BKT-2026-000002: Its retain-until is already 2029-01-31');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('a requester can only ask: no disposal list, Send request goes to the lead', async () => {
    const asRequester = units({
      units: [decisionUnit(1, { canDecide: false, canApprove: false })],
    });
    const fetchMock = stub(asRequester, () => json(201, { requestId: 'r1', actionItemId: 'i1' }));
    const onOpenChange = vi.fn();
    render(<RetentionDecisionDrawer open onOpenChange={onOpenChange} unitIds={['a']} />);
    const form = await screen.findByRole('form', {
      name: 'Request hold or extension for 1 unit',
    });
    expect(within(form).queryByText('Add to disposal list')).toBeNull();
    expect(form).toHaveTextContent('Pat Example, the project’s lead, decides.');
    await userEvent.click(within(form).getByRole('radio', { name: /Place a hold/ }));
    await userEvent.type(within(form).getByLabelText('Reason (required)'), 'More tests');
    await userEvent.click(within(form).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(posted(fetchMock, '/api/retention/requests')).toHaveLength(1));
    expect(posted(fetchMock, '/api/retention/requests')[0]).toMatchObject({
      kind: 'hold',
      projectId: 'p1',
      scope: 'units',
      unitIds: [decisionUnit(1).storageUnitId],
      reason: 'More tests',
    });
    expect(posted(fetchMock, '/api/retention/decisions')).toEqual([]);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
