import { describe, expect, it } from 'vitest';
import {
  receiptIdParamSchema,
  receiptLogQuerySchema,
  receiptLogUnitCode,
  receiptReceiverQuerySchema,
  splitReceiptLogSearch,
} from './receiving-log';
import { toFieldErrors } from './receipts';

const PROJECT = '00000000-0000-4000-8000-000000000201';
const RECEIVER = '00000000-0000-4000-8000-000000000301';

describe('receiving log query (MM-T51 T1)', () => {
  it('splits search into lower-case words and keeps dashes as typed (its columns are not folded, MM-T59)', () => {
    expect(splitReceiptLogSearch('  DEMO-2601   Alex demo-2601 ')).toEqual(['demo-2601', 'alex']);
    expect(splitReceiptLogSearch('Bridge – North')).toEqual(['bridge', '–', 'north']);
    expect(splitReceiptLogSearch(undefined)).toEqual([]);
  });

  it('defaults to page 1 of 25 with no filters', () => {
    expect(receiptLogQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
  });

  it('treats blank parameters as not set and coerces numbers from the query string', () => {
    const query = receiptLogQuerySchema.parse({
      search: '  DEMO-2601 ',
      projectId: '',
      receiverUserId: RECEIVER,
      receivedFrom: '2026-01-01',
      receivedTo: '2026-01-31',
      page: '2',
      pageSize: '100',
    });
    expect(query).toEqual({
      search: 'DEMO-2601',
      receiverUserId: RECEIVER,
      receivedFrom: '2026-01-01',
      receivedTo: '2026-01-31',
      page: 2,
      pageSize: 100,
    });
  });

  it('accepts a one-day range (bounds are inclusive)', () => {
    const query = receiptLogQuerySchema.parse({
      receivedFrom: '2026-01-15',
      receivedTo: '2026-01-15',
    });
    expect(query.receivedTo).toBe('2026-01-15');
  });

  it('rejects bad values with field errors instead of guessing', () => {
    for (const [bad, field] of [
      [{ pageSize: '101' }, 'pageSize'],
      [{ pageSize: '0' }, 'pageSize'],
      [{ page: '0' }, 'page'],
      [{ page: 'two' }, 'page'],
      [{ projectId: 'DEMO-2601' }, 'projectId'],
      [{ receiverUserId: 'JS' }, 'receiverUserId'],
      [{ receivedFrom: '2026-02-30' }, 'receivedFrom'],
      [{ receivedTo: '26-01-15' }, 'receivedTo'],
      [{ search: 'x'.repeat(201) }, 'search'],
    ] as const) {
      const result = receiptLogQuerySchema.safeParse(bad);
      expect(result.success, JSON.stringify(bad)).toBe(false);
      if (!result.success) expect(toFieldErrors(result.error)[0]?.field).toBe(field);
    }
    expect(receiptLogQuerySchema.parse({ projectId: PROJECT }).projectId).toBe(PROJECT);
  });

  it('refuses a reversed date range on the "received through" field', () => {
    const result = receiptLogQuerySchema.safeParse({
      receivedFrom: '2026-02-01',
      receivedTo: '2026-01-31',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(toFieldErrors(result.error)).toEqual([
        expect.objectContaining({ field: 'receivedTo', code: 'date_range_reversed' }),
      ]);
    }
  });

  it('compares a typed storage unit ID trimmed and in upper case', () => {
    expect(receiptLogUnitCode(' bkt-2026-000014 ')).toBe('BKT-2026-000014');
    expect(receiptLogUnitCode(undefined)).toBe('');
  });

  it('validates the receipt ID path and the receiver filter lookup', () => {
    expect(receiptIdParamSchema.safeParse({ receiptId: 'not-a-uuid' }).success).toBe(false);
    expect(receiptIdParamSchema.safeParse({ receiptId: PROJECT }).success).toBe(true);
    expect(receiptReceiverQuerySchema.parse({ search: ' js ', id: '' })).toEqual({ search: 'js' });
    expect(receiptReceiverQuerySchema.safeParse({ id: 'JS' }).success).toBe(false);
  });
});
