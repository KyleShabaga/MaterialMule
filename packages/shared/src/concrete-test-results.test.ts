import { describe, expect, it } from 'vitest';
import {
  concreteTestResultChanges,
  concreteTestResultSaveRequestSchema,
  type ConcreteTestResultValues,
} from './concrete-test-results';

// MM-V2-C07 T1: draft request contract, unit-free numeric shape and saved-versus-new correction
// classification. Fictional values only.

const KEY = '7b0c2f1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b';

const saved: ConcreteTestResultValues = {
  testedOn: '2026-11-06',
  tester: 'tester-a',
  maxLoad: 412.5,
  heightReadings: [],
  diameterReadings: [101.6],
  notes: null,
};

describe('concrete test-result drafts (MM-V2-C07)', () => {
  it('accepts a partial draft: missing readings are absent, not zero', () => {
    const parsed = concreteTestResultSaveRequestSchema.parse({ idempotencyKey: KEY, version: 0 });
    expect(parsed.maxLoad).toBeUndefined();
    expect(parsed.heightReadings).toBeUndefined();
    const withLoad = concreteTestResultSaveRequestSchema.parse({
      idempotencyKey: KEY,
      version: 0,
      maxLoad: 380.25,
      testedOn: null,
    });
    expect(withLoad).toMatchObject({ maxLoad: 380.25, testedOn: null });
  });

  it('refuses zero, negative and out-of-range readings and unknown fields', () => {
    const bad = (extra: object) =>
      concreteTestResultSaveRequestSchema.safeParse({ idempotencyKey: KEY, version: 1, ...extra })
        .success;
    expect(bad({ maxLoad: 0 })).toBe(false);
    expect(bad({ maxLoad: -3 })).toBe(false);
    expect(bad({ heightReadings: [203, 0] })).toBe(false);
    expect(bad({ diameterReadings: Array.from({ length: 11 }, () => 100) })).toBe(false);
    // No completed state, strength or unit can be sent: they are gated.
    expect(bad({ state: 'completed' })).toBe(false);
    expect(bad({ strength: 32.1 })).toBe(false);
    expect(bad({ loadUnit: 'lbf' })).toBe(false);
    expect(bad({ maxLoad: 412.5, heightReadings: [203.2, 203.4] })).toBe(true);
  });

  it('treats blank notes and reasons as absent', () => {
    const parsed = concreteTestResultSaveRequestSchema.parse({
      idempotencyKey: KEY,
      version: 1,
      notes: '   ',
      reason: '  ',
    });
    expect(parsed.notes).toBeNull();
    expect(parsed.reason).toBeUndefined();
  });

  it('a new attempt is entry, never a correction', () => {
    expect(concreteTestResultChanges(null, { maxLoad: 400, tester: 'tester-a' })).toEqual({
      changed: ['tester', 'maxLoad'],
      corrections: [],
    });
  });

  it('filling an empty saved field is entry; changing or clearing a saved value is a correction', () => {
    expect(concreteTestResultChanges(saved, { heightReadings: [203.2], notes: 'Capped' })).toEqual({
      changed: ['heightReadings', 'notes'],
      corrections: [],
    });
    expect(concreteTestResultChanges(saved, { maxLoad: 421.5 })).toEqual({
      changed: ['maxLoad'],
      corrections: ['maxLoad'],
    });
    expect(concreteTestResultChanges(saved, { diameterReadings: [] })).toEqual({
      changed: ['diameterReadings'],
      corrections: ['diameterReadings'],
    });
    expect(concreteTestResultChanges(saved, { tester: 'tester-b', testedOn: null })).toEqual({
      changed: ['testedOn', 'tester'],
      corrections: ['testedOn', 'tester'],
    });
  });

  it('sending a saved value again (or an omitted field) changes nothing', () => {
    expect(
      concreteTestResultChanges(saved, { maxLoad: 412.5, diameterReadings: [101.6], notes: null }),
    ).toEqual({ changed: [], corrections: [] });
    expect(concreteTestResultChanges(saved, {})).toEqual({ changed: [], corrections: [] });
  });
});
