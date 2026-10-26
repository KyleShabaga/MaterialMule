import { describe, expect, it } from 'vitest';
import { toFieldErrors } from './receipts';
import { putDraftSettingsRequestSchema } from './settings';

const body = (afterDays: unknown, enabled: unknown = true) => ({
  draftAutoDelete: { enabled, afterDays },
  version: 1,
});

describe('putDraftSettingsRequestSchema (TRP-T40)', () => {
  it('accepts 30 to 365 whole days', () => {
    for (const days of [30, 90, 365]) {
      expect(putDraftSettingsRequestSchema.safeParse(body(days)).success, String(days)).toBe(true);
    }
  });

  it('refuses days outside 30–365 with a field error on afterDays', () => {
    for (const days of [29, 366, 45.5, '90', null]) {
      const result = putDraftSettingsRequestSchema.safeParse(body(days));
      expect(result.success, String(days)).toBe(false);
      if (!result.success) {
        expect(toFieldErrors(result.error)).toEqual([
          expect.objectContaining({
            field: 'draftAutoDelete.afterDays',
            message: 'Enter a whole number of days from 30 to 365',
          }),
        ]);
      }
    }
  });

  it('needs a boolean switch, a version and no extra fields', () => {
    expect(putDraftSettingsRequestSchema.safeParse(body(90, 'yes')).success).toBe(false);
    expect(
      putDraftSettingsRequestSchema.safeParse({ draftAutoDelete: { enabled: true, afterDays: 90 } })
        .success,
    ).toBe(false);
    expect(putDraftSettingsRequestSchema.safeParse({ ...body(90), extra: 1 }).success).toBe(false);
  });
});
