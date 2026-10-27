import { describe, expect, it } from 'vitest';
import { needsLabelCheck, recentlyReceivedQuerySchema } from './dashboard';

describe('recentlyReceivedQuerySchema', () => {
  it('defaults to all, six units', () => {
    expect(recentlyReceivedQuerySchema.parse({})).toEqual({ show: 'all', limit: 6 });
    expect(recentlyReceivedQuerySchema.parse({ show: '', limit: '' })).toEqual({
      show: 'all',
      limit: 6,
    });
    expect(recentlyReceivedQuerySchema.parse({ show: 'labels', limit: '20' })).toEqual({
      show: 'labels',
      limit: 20,
    });
  });

  it('rejects unknown filters and out-of-range limits', () => {
    for (const query of [{ show: 'mine' }, { limit: '0' }, { limit: '21' }, { limit: 'x' }]) {
      expect(recentlyReceivedQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(
        false,
      );
    }
  });
});

describe('needsLabelCheck', () => {
  it('is true only for sent or uncertain labels nobody has confirmed', () => {
    const at = '2026-10-26T20:00:00.000Z';
    expect(needsLabelCheck({ status: 'sent', physicallyConfirmedAt: null })).toBe(true);
    expect(needsLabelCheck({ status: 'uncertain', physicallyConfirmedAt: null })).toBe(true);
    expect(needsLabelCheck({ status: 'sent', physicallyConfirmedAt: at })).toBe(false);
    expect(needsLabelCheck({ status: 'uncertain', physicallyConfirmedAt: at })).toBe(false);
    for (const status of ['queued', 'sending', 'failed'] as const) {
      expect(needsLabelCheck({ status, physicallyConfirmedAt: null })).toBe(false);
    }
    expect(needsLabelCheck(null)).toBe(false);
  });
});
