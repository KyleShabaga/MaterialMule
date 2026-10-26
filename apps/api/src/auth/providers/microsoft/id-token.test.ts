import { describe, expect, it } from 'vitest';
import { IdTokenRejected, verifyIdTokenClaims, type IdTokenExpectations } from './id-token.js';

// Fictional identifiers only (never a real tenant or object ID).
const TENANT = '11111111-2222-4333-8444-555555555555';
const OTHER_TENANT = '99999999-8888-4777-8666-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OID = '00000000-0000-4000-8000-00000000a001';
const NOW = new Date('2026-10-26T15:00:00Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);

const expected: IdTokenExpectations = {
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  tenantId: TENANT,
  clientId: CLIENT,
  nonce: 'nonce-123',
  now: NOW,
};

const claims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: expected.issuer,
  aud: CLIENT,
  tid: TENANT,
  oid: OID,
  sub: 'pairwise-subject',
  nonce: 'nonce-123',
  iat: nowSeconds - 10,
  nbf: nowSeconds - 10,
  exp: nowSeconds + 3600,
  name: 'Riley Example',
  preferred_username: 'riley@example.test',
  ...overrides,
});

function problemOf(overrides: Record<string, unknown>) {
  try {
    verifyIdTokenClaims(claims(overrides), expected);
    return 'accepted';
  } catch (error) {
    return error instanceof IdTokenRejected ? error.problem : String(error);
  }
}

// TRP-T05 T1: token claim validation.
describe('verifyIdTokenClaims', () => {
  it('accepts a token for this tenant and app and keys the identity on tenant + oid', () => {
    expect(verifyIdTokenClaims(claims(), expected)).toEqual({
      tenantId: TENANT,
      objectId: OID,
      name: 'Riley Example',
      preferredUsername: 'riley@example.test',
    });
  });

  it('rejects the wrong issuer, audience, tenant or nonce', () => {
    expect(problemOf({ iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` })).toBe(
      'invalid_issuer',
    );
    expect(problemOf({ aud: 'another-app' })).toBe('invalid_audience');
    expect(problemOf({ tid: OTHER_TENANT })).toBe('wrong_tenant');
    expect(problemOf({ nonce: 'replayed' })).toBe('invalid_nonce');
    expect(problemOf({ nonce: undefined })).toBe('invalid_nonce');
  });

  it('rejects expired and not-yet-valid tokens beyond five minutes of clock skew', () => {
    expect(problemOf({ exp: nowSeconds - 301 })).toBe('expired');
    expect(problemOf({ exp: undefined })).toBe('expired');
    expect(problemOf({ exp: nowSeconds - 60 })).toBe('accepted');
    expect(problemOf({ nbf: nowSeconds + 301 })).toBe('not_yet_valid');
  });

  it('requires an object ID; names and email are never the key', () => {
    expect(problemOf({ oid: undefined })).toBe('missing_object_id');
    expect(problemOf({ oid: 'riley@example.test' })).toBe('missing_object_id');
  });

  it('rejects guests from other tenants or consumer accounts', () => {
    expect(problemOf({ idp: `https://sts.windows.net/${OTHER_TENANT}/` })).toBe('guest_account');
    expect(problemOf({ idp: 'live.com' })).toBe('guest_account');
    expect(problemOf({ acct: 1 })).toBe('guest_account');
    expect(problemOf({ idp: `https://sts.windows.net/${TENANT}/`, acct: 0 })).toBe('accepted');
  });
});
