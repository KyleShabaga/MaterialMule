import type { StorageUnitRetention } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnitRetentionCard } from './RetentionSections';

// MM-T29 UI: the unit Retention card (dates, hold with reason and who, tested-unit exception)
// and the request form for people without authority. Fictional data only.

const view = (overrides: Partial<StorageUnitRetention> = {}): StorageUnitRetention => ({
  storageUnitId: 'u1',
  projectId: 'p1',
  retention: {
    receivedDate: '2026-10-23',
    minimumRetainUntil: '2027-10-23',
    effectiveRetainUntil: '2028-06-30',
    onHold: true,
    eligibleByDate: false,
    retentionExempt: false,
    asOf: '2026-10-27',
  },
  holds: [
    {
      id: 'h1',
      projectId: 'p1',
      scope: 'project',
      units: [],
      reason: 'Claim review',
      placedBy: { userId: 'lm', initials: 'LM', name: 'Lee Manager' },
      placedAt: '2026-10-27T16:00:00.000Z',
      fromRequestId: null,
      active: true,
      releasedBy: null,
      releasedAt: null,
      releaseReason: null,
      version: 1,
    },
  ],
  extensions: [],
  canManage: false,
  canRequest: true,
  ...overrides,
});

function stub(body: StorageUnitRetention) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url.endsWith('/retention')) {
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ requestId: 'r1', actionItemId: 'a1' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('Retention card (MM-T29)', () => {
  it('shows minimum and effective dates and the hold with its reason and who placed it', async () => {
    stub(view());
    render(<UnitRetentionCard unitId="u1" unitType="bucket" disposed={false} />);
    const card = await screen.findByRole('region', { name: 'Retention' });
    expect(card).toHaveTextContent('Retain until 2028-06-30 · On hold');
    expect(card).toHaveTextContent('Minimum retain-until2027-10-23');
    expect(within(card).getByRole('listitem', { name: 'Hold: Claim review' })).toHaveTextContent(
      'Placed by LM · Lee Manager',
    );
    // No authority: no Release, only a request.
    expect(within(card).queryByRole('button', { name: 'Release' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Request hold or extension' })).toBeVisible();
  });

  it('a tested unit shows Not applicable and keeps the hold as history', async () => {
    stub(view({ retention: { ...view().retention, retentionExempt: true } }));
    render(<UnitRetentionCard unitId="u1" unitType="shelby_tube" disposed={false} />);
    const card = await screen.findByRole('region', { name: 'Retention' });
    expect(card).toHaveTextContent('Retention: Not applicable — tested Shelby tube');
    expect(card).toHaveTextContent(/stay as history; they don’t block that removal/);
    expect(within(card).getByRole('listitem', { name: 'Hold: Claim review' })).toBeVisible();
  });

  it('a request needs a reason and goes to the retention request route', async () => {
    const user = userEvent.setup();
    const fetchMock = stub(view());
    render(<UnitRetentionCard unitId="u1" unitType="bucket" disposed={false} />);
    await user.click(await screen.findByRole('button', { name: 'Request hold or extension' }));
    const form = screen.getByRole('form', { name: 'Request a hold or extension' });
    const send = within(form).getByRole('button', { name: 'Send request' });
    expect(send).toBeDisabled();
    await user.type(within(form).getByLabelText('Reason (required)'), 'Client may dispute');
    await user.click(send);
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/retention/requests');
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      kind: 'hold',
      projectId: 'p1',
      scope: 'units',
      unitIds: ['u1'],
      reason: 'Client may dispute',
    });
  });
});
