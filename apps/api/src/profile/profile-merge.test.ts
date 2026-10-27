import { describe, expect, it } from 'vitest';
import { mergeProfile, type GraphProfile, type ProfileFields } from './profile-merge.js';

const identity = { name: 'Riley Example', preferredUsername: 'riley@example.test' };

const graph = (overrides: Partial<GraphProfile> = {}): GraphProfile => ({
  displayName: 'Riley Example',
  givenName: 'Riley',
  surname: 'Example',
  mail: 'riley.example@example.test',
  userPrincipalName: 'riley@example.test',
  jobTitle: 'Field Technician',
  department: 'Geotechnical',
  officeLocation: 'Edmonton',
  ...overrides,
});

const stored: ProfileFields = {
  display_name: 'Riley Example',
  given_name: 'Riley',
  surname: 'Example',
  work_email: 'riley.example@example.test',
  sign_in_username: 'riley@example.test',
  job_title: 'Field Technician',
  department: 'Geotechnical',
  office_location: 'Edmonton',
};

// MM-T05 T2: profile merge rules.
describe('mergeProfile', () => {
  it('fills a new user from Graph', () => {
    const result = mergeProfile(null, graph(), identity);
    expect(result.source).toBe('microsoft_graph');
    expect(result.fields).toEqual(stored);
  });

  it('keeps every known value when Graph fails (AC5)', () => {
    const result = mergeProfile(stored, null, identity);
    expect(result.fields).toEqual(stored);
    expect(result.source).toBeNull();
    expect(result.changes).toEqual({ before: {}, after: {} });
  });

  it('starts a first sign-in from the ID token when Graph fails', () => {
    const result = mergeProfile(null, null, identity);
    expect(result.source).toBe('microsoft_id_token');
    expect(result.fields).toMatchObject({
      display_name: 'Riley Example',
      sign_in_username: 'riley@example.test',
      work_email: null,
    });
  });

  it('records only changed fields, e.g. a new email (AC4)', () => {
    const result = mergeProfile(stored, graph({ mail: 'riley.new@example.test' }), identity);
    expect(result.changes).toEqual({
      before: { work_email: 'riley.example@example.test' },
      after: { work_email: 'riley.new@example.test' },
    });
  });

  it('keeps work email separate from the sign-in username', () => {
    const result = mergeProfile(null, graph({ mail: null }), identity);
    expect(result.fields.work_email).toBeNull();
    expect(result.fields.sign_in_username).toBe('riley@example.test');
  });

  it('never produces initials: official initials stay admin-confirmed (AC6)', () => {
    const result = mergeProfile(stored, graph({ givenName: 'Kim', surname: 'Smith' }), identity);
    expect(Object.keys(result.fields)).not.toContain('official_initials');
  });

  it('trims, treats blanks as missing and never leaves the display name empty', () => {
    const result = mergeProfile(
      null,
      graph({ displayName: '   ', jobTitle: '  Lab Tech  ', department: '' }),
      identity,
    );
    expect(result.fields.display_name).toBe('Riley Example');
    expect(result.fields.job_title).toBe('Lab Tech');
    expect(result.fields.department).toBeNull();
    const nameless = mergeProfile(null, graph({ displayName: null }), {
      name: null,
      preferredUsername: null,
    });
    expect(nameless.fields.display_name).toBe('Microsoft user');
  });
});
