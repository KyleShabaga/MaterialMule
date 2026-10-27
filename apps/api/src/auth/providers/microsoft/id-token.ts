// Claim checks for Microsoft Entra ID tokens (MM-T05). openid-client has already verified the
// signature against the tenant's keys and the standard claims; these checks repeat the ones that
// matter for who may sign in, so a library default can't quietly loosen them.

export interface IdTokenExpectations {
  issuer: string;
  tenantId: string;
  clientId: string;
  nonce: string;
  now: Date;
}

/** Who signed in: the stable identity key (tenant + object ID) and display claims. */
export interface VerifiedMicrosoftIdentity {
  tenantId: string;
  objectId: string;
  name: string | null;
  preferredUsername: string | null;
}

export type IdTokenProblem =
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'wrong_tenant'
  | 'invalid_nonce'
  | 'expired'
  | 'not_yet_valid'
  | 'missing_object_id'
  | 'guest_account';

export class IdTokenRejected extends Error {
  constructor(readonly problem: IdTokenProblem) {
    super(`ID token rejected: ${problem}`);
    this.name = 'IdTokenRejected';
  }
}

const CLOCK_SKEW_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Validates issuer, audience, tenant, nonce and lifetime and rejects guests. A guest's token
 * carries `idp` naming their home tenant (or a consumer provider), or `acct: 1` when the app
 * registration includes that optional claim.
 */
export function verifyIdTokenClaims(
  claims: Record<string, unknown>,
  expected: IdTokenExpectations,
): VerifiedMicrosoftIdentity {
  if (claims.iss !== expected.issuer) throw new IdTokenRejected('invalid_issuer');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expected.clientId)) throw new IdTokenRejected('invalid_audience');
  if (claims.tid !== expected.tenantId) throw new IdTokenRejected('wrong_tenant');
  if (claims.nonce !== expected.nonce) throw new IdTokenRejected('invalid_nonce');

  const nowSeconds = Math.floor(expected.now.getTime() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    throw new IdTokenRejected('expired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new IdTokenRejected('not_yet_valid');
  }

  const objectId = asString(claims.oid);
  if (!objectId || !UUID.test(objectId)) throw new IdTokenRejected('missing_object_id');

  const idp = asString(claims.idp);
  const ownIssuers = [
    expected.issuer,
    `https://sts.windows.net/${expected.tenantId}/`,
    `https://login.microsoftonline.com/${expected.tenantId}/v2.0`,
  ];
  if ((idp && !ownIssuers.includes(idp)) || claims.acct === 1) {
    throw new IdTokenRejected('guest_account');
  }

  return {
    tenantId: expected.tenantId,
    objectId: objectId.toLowerCase(),
    name: asString(claims.name),
    preferredUsername: asString(claims.preferred_username),
  };
}
