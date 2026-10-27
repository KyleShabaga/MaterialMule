import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

// A fake Microsoft Entra ID tenant plus Microsoft Graph /me, for tests only (MM-T05). Every user
// and identifier here is fictional. It speaks just enough OpenID Connect for the real client code:
// discovery, JWKS, an authorize endpoint (a page of buttons, or an automatic choice for API
// tests), a token endpoint that checks PKCE and the client secret, and Graph /v1.0/me.

export const MOCK_TENANT_ID = '11111111-2222-4333-8444-555555555555';
export const MOCK_CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const MOCK_CLIENT_SECRET = 'mock-client-secret-not-a-real-secret';

export interface MockGraphProfile {
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
}

export interface MockUser {
  key: string;
  oid: string;
  name: string;
  preferredUsername: string;
  /** Overrides for the ID token, e.g. another `tid` or a guest `idp`. */
  extraClaims?: Record<string, unknown>;
  graph: MockGraphProfile;
  /** When set, Graph answers with this HTTP status instead of the profile. */
  graphStatus?: number;
}

export interface AuthorizeRequestRecord {
  scope: string | null;
  prompt: string | null;
  codeChallengeMethod: string | null;
  responseType: string | null;
}

interface PendingCode {
  user: MockUser;
  nonce: string | null;
  codeChallenge: string | null;
  redirectUri: string;
}

export interface MockOidc {
  url: string;
  issuer: string;
  users: Map<string, MockUser>;
  authorizeRequests: AuthorizeRequestRecord[];
  graphSelects: string[];
  /** API tests: the user the next authorize request signs in, without a page. */
  autoSignIn(key: string | null): void;
  /** API tests: the next authorize request returns this OAuth error instead. */
  autoError(error: { error: string; description?: string; subcode?: string } | null): void;
  close(): Promise<void>;
}

const html = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Mock Microsoft sign-in</title></head><body>${body}</body></html>`;

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export function fictionalUsers(): MockUser[] {
  const user = (key: string, n: number, name: string, extra: Partial<MockUser> = {}): MockUser => {
    const [given, surname] = name.split(' ');
    return {
      key,
      oid: `00000000-0000-4000-8000-0000000a${String(n).padStart(4, '0')}`,
      name,
      preferredUsername: `${key}@example.test`,
      graph: {
        displayName: name,
        givenName: given ?? null,
        surname: surname ?? null,
        mail: `${key}.mail@example.test`,
        userPrincipalName: `${key}@example.test`,
        jobTitle: 'Field Technician',
        department: 'Geotechnical',
        officeLocation: 'Edmonton',
      },
      ...extra,
    };
  };
  return [
    user('avery', 1, 'Avery Bootstrap', {
      graph: {
        displayName: 'Avery Bootstrap',
        givenName: 'Avery',
        surname: 'Bootstrap',
        mail: 'avery.mail@example.test',
        userPrincipalName: 'avery@example.test',
        jobTitle: 'Operations Manager',
        department: 'Administration',
        officeLocation: 'Edmonton',
      },
    }),
    user('riley', 2, 'Riley Example'),
    user('morgan', 3, 'Morgan Example'),
    user('casey', 4, 'Casey Example'),
    user('drew', 5, 'Drew Example'),
    user('outsider', 6, 'Outside Tenant', {
      extraClaims: { tid: '99999999-8888-4777-8666-555555555555' },
    }),
    user('guest', 7, 'Guest Visitor', {
      extraClaims: { idp: 'https://sts.windows.net/99999999-8888-4777-8666-555555555555/' },
    }),
    user('nograph', 8, 'Graph Failure', { graphStatus: 503 }),
    // Added by an admin before their first sign-in (MM-T07 AC6).
    user('jordan', 9, 'Jordan Ahead'),
  ];
}

/** Starts the mock on 127.0.0.1 (`port` 0 picks a free one). */
export async function startMockOidc(port = 0, users = fictionalUsers()): Promise<MockOidc> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const kid = randomUUID();
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, use: 'sig', alg: 'RS256' };
  const userMap = new Map(users.map((u) => [u.key, u]));
  const codes = new Map<string, PendingCode>();
  const tokens = new Map<string, MockUser>();
  const authorizeRequests: AuthorizeRequestRecord[] = [];
  const graphSelects: string[] = [];
  let autoKey: string | null = null;
  let autoErr: { error: string; description?: string; subcode?: string } | null = null;
  let base = '';
  const tenantPath = `/${MOCK_TENANT_ID}`;
  const issuer = () => `${base}${tenantPath}/v2.0`;

  function redirectWithCode(response: ServerResponse, params: URLSearchParams, user: MockUser) {
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      user,
      nonce: params.get('nonce'),
      codeChallenge: params.get('code_challenge'),
      redirectUri: params.get('redirect_uri') ?? '',
    });
    const target = new URL(params.get('redirect_uri') ?? '');
    target.searchParams.set('code', code);
    if (params.get('state')) target.searchParams.set('state', params.get('state')!);
    response.writeHead(302, { location: target.toString() });
    response.end();
  }

  function redirectWithError(
    response: ServerResponse,
    params: URLSearchParams,
    error: { error: string; description?: string; subcode?: string },
  ) {
    const target = new URL(params.get('redirect_uri') ?? '');
    target.searchParams.set('error', error.error);
    if (error.description) target.searchParams.set('error_description', error.description);
    if (error.subcode) target.searchParams.set('error_subcode', error.subcode);
    if (params.get('state')) target.searchParams.set('state', params.get('state')!);
    response.writeHead(302, { location: target.toString() });
    response.end();
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', base);
    const path = url.pathname;

    if (path === `${tenantPath}/v2.0/.well-known/openid-configuration`) {
      return json(response, 200, {
        issuer: issuer(),
        authorization_endpoint: `${base}${tenantPath}/oauth2/v2.0/authorize`,
        token_endpoint: `${base}${tenantPath}/oauth2/v2.0/token`,
        jwks_uri: `${base}${tenantPath}/discovery/v2.0/keys`,
        response_types_supported: ['code'],
        subject_types_supported: ['pairwise'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (path === `${tenantPath}/discovery/v2.0/keys`) {
      return json(response, 200, { keys: [publicJwk] });
    }
    if (path === `${tenantPath}/oauth2/v2.0/authorize`) {
      const params = url.searchParams;
      authorizeRequests.push({
        scope: params.get('scope'),
        prompt: params.get('prompt'),
        codeChallengeMethod: params.get('code_challenge_method'),
        responseType: params.get('response_type'),
      });
      if (params.get('client_id') !== MOCK_CLIENT_ID) {
        return redirectWithError(response, params, { error: 'unauthorized_client' });
      }
      if (autoErr) {
        const error = autoErr;
        autoErr = null;
        return redirectWithError(response, params, error);
      }
      if (autoKey) {
        const user = userMap.get(autoKey)!;
        autoKey = null;
        return redirectWithCode(response, params, user);
      }
      // Interactive: a page of fictional accounts, as a browser test would see.
      const choices = [...userMap.values()]
        .map((user) => {
          const next = new URLSearchParams(params);
          next.set('mock_user', user.key);
          return `<li><a href="${escape(`${tenantPath}/oauth2/v2.0/choose?${next}`)}">${escape(user.name)}</a></li>`;
        })
        .join('');
      const cancel = new URLSearchParams(params);
      cancel.set('mock_user', '__cancel');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(
        html(
          `<h1>Mock Microsoft sign-in</h1><p>Prompt: ${escape(params.get('prompt') ?? 'none')}</p>` +
            `<ul>${choices}</ul><a href="${escape(`${tenantPath}/oauth2/v2.0/choose?${cancel}`)}">Cancel</a>`,
        ),
      );
    }
    if (path === `${tenantPath}/oauth2/v2.0/choose`) {
      const params = url.searchParams;
      const key = params.get('mock_user');
      if (key === '__cancel') {
        return redirectWithError(response, params, {
          error: 'access_denied',
          description: 'AADSTS50126: the user cancelled (mock)',
          subcode: 'cancel',
        });
      }
      const user = key ? userMap.get(key) : undefined;
      if (!user) return json(response, 404, { error: 'unknown mock user' });
      return redirectWithCode(response, params, user);
    }
    if (path === `${tenantPath}/oauth2/v2.0/token` && request.method === 'POST') {
      const form = await readForm(request);
      const pending = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (!pending) return json(response, 400, { error: 'invalid_grant' });
      if (
        form.get('client_id') !== MOCK_CLIENT_ID ||
        form.get('client_secret') !== MOCK_CLIENT_SECRET
      ) {
        return json(response, 401, { error: 'invalid_client' });
      }
      if (form.get('redirect_uri') !== pending.redirectUri) {
        return json(response, 400, { error: 'invalid_grant', error_description: 'redirect_uri' });
      }
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!pending.codeChallenge || challenge !== pending.codeChallenge) {
        return json(response, 400, { error: 'invalid_grant', error_description: 'PKCE' });
      }
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        tid: MOCK_TENANT_ID,
        oid: pending.user.oid,
        name: pending.user.name,
        preferred_username: pending.user.preferredUsername,
        ...(pending.nonce ? { nonce: pending.nonce } : {}),
        ver: '2.0',
        ...pending.user.extraClaims,
      })
        .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
        .setIssuer(issuer())
        .setAudience(MOCK_CLIENT_ID)
        .setSubject(`pairwise-${pending.user.key}`)
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 3600)
        .sign(privateKey);
      const accessToken = `mock-at-${randomBytes(16).toString('hex')}`;
      tokens.set(accessToken, pending.user);
      return json(response, 200, {
        token_type: 'Bearer',
        scope: 'openid profile User.Read',
        expires_in: 3600,
        access_token: accessToken,
        id_token: idToken,
      });
    }
    if (path === '/v1.0/me') {
      graphSelects.push(url.searchParams.get('$select') ?? '');
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      const user = tokens.get(token);
      if (!user) return json(response, 401, { error: { code: 'InvalidAuthenticationToken' } });
      const current = userMap.get(user.key) ?? user;
      if (current.graphStatus) {
        return json(response, current.graphStatus, { error: { code: 'ServiceUnavailable' } });
      }
      return json(response, 200, { '@odata.context': 'mock', ...current.graph });
    }
    json(response, 404, { error: 'not_found' });
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      json(response, 500, { error: String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    get issuer() {
      return issuer();
    },
    users: userMap,
    authorizeRequests,
    graphSelects,
    autoSignIn(key) {
      if (key && !userMap.has(key)) throw new Error(`unknown mock user ${key}`);
      autoKey = key;
    },
    autoError(error) {
      autoErr = error;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
