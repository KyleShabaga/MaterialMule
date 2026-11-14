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
