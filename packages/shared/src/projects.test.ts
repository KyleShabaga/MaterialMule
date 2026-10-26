import { describe, expect, it } from 'vitest';
import {
  createProjectRequestSchema,
  createTestHoleRequestSchema,
  normalizeProjectNumber,
  normalizeTestHoleName,
  projectLabel,
  projectNumberKey,
  testHoleNameKey,
} from './projects';

const PM_PE = '00000000-0000-4000-8000-000000000101';

describe('normalisation (TRP-T08 T1)', () => {
  it('trims project numbers and compares them ignoring case', () => {
    expect(normalizeProjectNumber('  67997 ')).toBe('67997');
    expect(projectNumberKey(' Demo-2601 ')).toBe('demo-2601');
  });

  it('trims hole names but otherwise keeps them exactly as entered', () => {
    expect(normalizeTestHoleName(' TH26-01 ')).toBe('TH26-01');
    expect(testHoleNameKey('th26-01 ')).toBe(testHoleNameKey('TH26-01'));
    // AC6: a TH26 hole drilled in 2027 keeps its assigned year.
    expect(normalizeTestHoleName('TH26-05')).toBe('TH26-05');
  });

  it('formats a project as the picker lists it', () => {
    expect(
      projectLabel({ projectNumber: '67997', name: 'West Pine Creek Ph.3', client: 'Jacobs' }),
    ).toBe('67997 · West Pine Creek Ph.3 · Jacobs');
  });
});

describe('createTestHoleRequestSchema', () => {
  it.each(['TH26-01', 'BH-01', 'TP-03', 'A', 'x'.repeat(40)])('accepts %s', (name) => {
    expect(createTestHoleRequestSchema.parse({ name }).name).toBe(name);
  });

  it('stores the trimmed name', () => {
    expect(createTestHoleRequestSchema.parse({ name: '  TH26-03\t' }).name).toBe('TH26-03');
  });

  it.each(['', '   ', 'x'.repeat(41), 'TH\u000026', 'TH\n26', 'TH\u007f'])('rejects %j', (name) => {
    expect(createTestHoleRequestSchema.safeParse({ name }).success).toBe(false);
  });
});

describe('createProjectRequestSchema', () => {
  it('trims fields', () => {
    const parsed = createProjectRequestSchema.parse({
      projectNumber: ' 70001 ',
      name: ' Example ',
      client: ' Example Client ',
      pmPeUserId: PM_PE,
    });
    expect(parsed).toMatchObject({
      projectNumber: '70001',
      name: 'Example',
      client: 'Example Client',
    });
  });

  it('reports each missing field by name', () => {
    const result = createProjectRequestSchema.safeParse({ projectNumber: '70001', name: 'X' });
    expect(result.success).toBe(false);
    const fields = result.error!.issues.map((issue) => issue.path.join('.'));
    expect(fields).toEqual(expect.arrayContaining(['client', 'pmPeUserId']));
  });
});
