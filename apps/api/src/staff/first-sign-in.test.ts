import { describe, expect, it } from 'vitest';
import { findPreprovisionedMatch, normalizeUpn } from './first-sign-in.js';

describe('first-sign-in linking rule (T1)', () => {
  const entry = { userId: 'jordan', expectedUpn: 'jsmith@example.com', linked: false };

  it('links an unlinked entry whose expected UPN matches exactly', () => {
    expect(findPreprovisionedMatch('jsmith@example.com', [entry])).toBe('jordan');
  });

  it('treats UPN case and surrounding spaces as the same UPN', () => {
    expect(normalizeUpn('  JSmith@Example.COM ')).toBe('jsmith@example.com');
    expect(findPreprovisionedMatch('JSMITH@example.com', [entry])).toBe('jordan');
  });

  it('never links a different UPN, even for someone with the same initials or name', () => {
    // Jamie Song (also "JS") signs in: nothing about initials or name is compared.
    expect(findPreprovisionedMatch('jsong@example.com', [entry])).toBeNull();
    expect(findPreprovisionedMatch('jsmith@example.org', [entry])).toBeNull();
    expect(findPreprovisionedMatch('jsmith', [entry])).toBeNull();
  });

  it('does not link an entry that already has a sign-in identity', () => {
    expect(findPreprovisionedMatch('jsmith@example.com', [{ ...entry, linked: true }])).toBeNull();
  });

  it('links nothing when the match is ambiguous or the UPN is blank', () => {
    expect(
      findPreprovisionedMatch('jsmith@example.com', [entry, { ...entry, userId: 'other' }]),
    ).toBeNull();
    expect(findPreprovisionedMatch('   ', [{ ...entry, expectedUpn: '' }])).toBeNull();
    expect(
      findPreprovisionedMatch('jsmith@example.com', [{ ...entry, expectedUpn: null }]),
    ).toBeNull();
  });
});
