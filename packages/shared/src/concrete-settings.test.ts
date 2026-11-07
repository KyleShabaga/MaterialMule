import { describe, expect, it } from 'vitest';
import {
  CONCRETE_SETTINGS_DEFAULTS,
  grantConcreteLabManagerRequestSchema,
  updateConcreteSettingsRequestSchema,
} from './index';

// MM-V2-C02 shared contracts. Fictional IDs only.
const ID = '00000000-0000-4000-8000-000000000101';

describe('concrete settings contracts (MM-V2-C02)', () => {
  it('keeps the confirmed defaults and leaves machine information unset', () => {
    expect(CONCRETE_SETTINGS_DEFAULTS).toEqual({
      defaultSpecimenAges: [7, 28, 28, 'HOLD'],
      holdDurationDays: 56,
      includeMachineInfo: null,
    });
  });

  it('accepts a partial save with a version; a blank reason is no reason', () => {
    expect(
      updateConcreteSettingsRequestSchema.parse({
        version: 0,
        defaultSpecimenAges: [3, 7, 28, 'HOLD'],
        includeMachineInfo: null,
        reason: '  ',
      }),
    ).toEqual({
      version: 0,
      defaultSpecimenAges: [3, 7, 28, 'HOLD'],
      includeMachineInfo: null,
      reason: null,
    });
    expect(updateConcreteSettingsRequestSchema.parse({ version: 4 })).toEqual({ version: 4 });
  });

  it.each([
    [{}],
    [{ version: 1.5 }],
    [{ version: 0, defaultSpecimenAges: [] }],
    [{ version: 0, defaultSpecimenAges: [0] }],
    [{ version: 0, defaultSpecimenAges: ['hold'] }],
    [{ version: 0, defaultSpecimenAges: Array.from({ length: 27 }, () => 28) }],
    [{ version: 0, holdDurationDays: 0 }],
    [{ version: 0, holdDurationDays: 1000 }],
    [{ version: 0, reviewerUserIds: [ID] }],
    [{ version: 0, reason: 'bad\u0007' }],
  ])('refuses %j', (body) => {
    expect(updateConcreteSettingsRequestSchema.safeParse(body).success).toBe(false);
  });

  it('a concrete Lab Manager grant needs a person, a reason and a key', () => {
    expect(
      grantConcreteLabManagerRequestSchema.safeParse({
        labManagerUserId: ID,
        reason: 'Runs holds here',
        idempotencyKey: ID,
      }).success,
    ).toBe(true);
    for (const body of [
      { labManagerUserId: ID, idempotencyKey: ID },
      { labManagerUserId: 'x', reason: 'r', idempotencyKey: ID },
      { labManagerUserId: ID, reason: 'r' },
    ]) {
      expect(grantConcreteLabManagerRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});
