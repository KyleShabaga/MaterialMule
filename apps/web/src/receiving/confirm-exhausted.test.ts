import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmReceipt } from './api';

// BUG-008: a full ID counter is reported as such, once, instead of being retried as a lost answer.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('confirmReceipt when the year’s IDs are used up', () => {
  it('shows the server’s message and does not retry', async () => {
    const message =
      'No ST- storage unit IDs are left for 2026 (the last is ST-2026-999999). Nothing was saved. Tell an administrator.';
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: 'storage_unit_ids_exhausted', prefix: 'ST', year: 2026, message }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await confirmReceipt(
      {
        idempotencyKey: '00000000-0000-4000-8000-0000000000aa',
        projectId: '00000000-0000-4000-8000-000000000201',
        receivedDate: '2026-10-23',
        receiverUserId: '00000000-0000-4000-8000-000000000102',
        description: null,
        units: [],
      },
      [0, 0, 0],
    );

    expect(outcome).toEqual({ kind: 'failed', message });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
