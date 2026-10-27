import * as oidc from 'openid-client';
import type { AppConfig } from '../../../config/env.js';
import {
  IdTokenRejected,
  verifyIdTokenClaims,
  type VerifiedMicrosoftIdentity,
} from './id-token.js';

/**
 * Delegated permissions requested from Microsoft: sign-in (`openid profile`) and the signed-in
 * user's own profile (`User.Read`). No mailbox, calendar, contacts or directory scopes (AC8).
 */
export const MICROSOFT_SCOPES = 'openid profile User.Read';

export interface MicrosoftSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorityHost: string;
  graphBaseUrl: string;
  /** Plain HTTP endpoints, allowed only for the mock tenant outside production. */
  allowInsecure: boolean;
}

/** The Microsoft provider's settings, or null when its configuration is absent (provider off). */
export function microsoftSettings(config: AppConfig): MicrosoftSettings | null {
  if (
    !config.MICROSOFT_TENANT_ID ||
    !config.MICROSOFT_CLIENT_ID ||
    !config.MICROSOFT_CLIENT_SECRET ||
    !config.MICROSOFT_REDIRECT_URI
  ) {
    return null;
  }
  const authorityHost = config.MICROSOFT_AUTHORITY_HOST.replace(/\/+$/, '');
  const graphBaseUrl = config.MICROSOFT_GRAPH_BASE_URL.replace(/\/+$/, '');
  return {
    tenantId: config.MICROSOFT_TENANT_ID,
    clientId: config.MICROSOFT_CLIENT_ID,
    clientSecret: config.MICROSOFT_CLIENT_SECRET,
    redirectUri: config.MICROSOFT_REDIRECT_URI,
    authorityHost,
    graphBaseUrl,
    allowInsecure:
      config.APP_ENV !== 'production' &&
      (authorityHost.startsWith('http:') || graphBaseUrl.startsWith('http:')),
  };
}

/** What the browser needs to start a sign-in, and what the server keeps to finish it. */
export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface CompletedSignIn {
  identity: VerifiedMicrosoftIdentity;
  /** Delegated Graph token for this user. Kept on the server only, never sent to the browser. */
  accessToken: string;
  accessTokenExpiresAt: Date;
}

/** An external identity provider the app can sign people in with (MM-T05 provider abstraction). */
export interface ExternalIdentityProvider {
  readonly id: 'microsoft';
  beginSignIn(options: { selectAccount: boolean }): Promise<AuthorizationRequest>;
  completeSignIn(input: {
    code: string;
    state: string;
    expected: { state: string; nonce: string; codeVerifier: string };
  }): Promise<CompletedSignIn>;
}

export class ProviderSignInFailed extends Error {
  constructor(
    readonly reason: 'wrong_tenant' | 'guest_account' | 'sign_in_failed',
    detail: string,
  ) {
    super(detail);
    this.name = 'ProviderSignInFailed';
  }
}

/**
 * Single-tenant Microsoft Entra ID sign-in with the authorization-code flow, PKCE (S256), state
 * and nonce, using the OpenID-certified `openid-client` library as a confidential client. The
 * ID token's signature is checked against the tenant's published keys (non-repudiation checks
 * on), then issuer, audience, tenant, nonce and lifetime are checked again by verifyIdTokenClaims.
 */
export class EntraIdentityProvider implements ExternalIdentityProvider {
  readonly id = 'microsoft' as const;
  private configuration?: Promise<oidc.Configuration>;

  constructor(private readonly settings: MicrosoftSettings) {}

  get issuer(): string {
    return `${this.settings.authorityHost}/${this.settings.tenantId}/v2.0`;
  }

  private config(): Promise<oidc.Configuration> {
    this.configuration ??= oidc
      .discovery(
        new URL(this.issuer),
        this.settings.clientId,
        this.settings.clientSecret,
        oidc.ClientSecretPost(this.settings.clientSecret),
        {
          execute: [
            oidc.enableNonRepudiationChecks,
            ...(this.settings.allowInsecure ? [oidc.allowInsecureRequests] : []),
          ],
        },
      )
      .catch((error: unknown) => {
        // Don't cache a failed discovery (e.g. Microsoft briefly unreachable).
        this.configuration = undefined;
        throw error;
      });
    return this.configuration;
  }

  async beginSignIn({ selectAccount }: { selectAccount: boolean }): Promise<AuthorizationRequest> {
    const config = await this.config();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const parameters: Record<string, string> = {
      redirect_uri: this.settings.redirectUri,
      response_type: 'code',
      scope: MICROSOFT_SCOPES,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    };
    if (selectAccount) {
      // Shared devices: never silently reuse the previous person's Microsoft session.
      parameters.prompt = 'select_account';
    }
    return {
      url: oidc.buildAuthorizationUrl(config, parameters).toString(),
      state,
      nonce,
      codeVerifier,
    };
  }

  async completeSignIn(input: {
    code: string;
    state: string;
    expected: { state: string; nonce: string; codeVerifier: string };
  }): Promise<CompletedSignIn> {
    const config = await this.config();
    const callback = new URL(this.settings.redirectUri);
    callback.searchParams.set('code', input.code);
    callback.searchParams.set('state', input.state);
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(config, callback, {
        pkceCodeVerifier: input.expected.codeVerifier,
        expectedState: input.expected.state,
        expectedNonce: input.expected.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      throw new ProviderSignInFailed('sign_in_failed', describe(error));
    }
    const claims = tokens.claims();
    if (!claims) {
      throw new ProviderSignInFailed('sign_in_failed', 'no ID token');
    }
    let identity: VerifiedMicrosoftIdentity;
    try {
      identity = verifyIdTokenClaims(claims as Record<string, unknown>, {
        issuer: this.issuer,
        tenantId: this.settings.tenantId,
        clientId: this.settings.clientId,
        nonce: input.expected.nonce,
        now: new Date(),
      });
    } catch (error) {
      if (error instanceof IdTokenRejected) {
        const reason =
          error.problem === 'wrong_tenant' || error.problem === 'guest_account'
            ? error.problem
            : 'sign_in_failed';
        throw new ProviderSignInFailed(reason, error.message);
      }
      throw error;
    }
    return {
      identity,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    };
  }
}

/** An error description for logs: the error's name and code, never token or response bodies. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name} (${code})` : error.name;
  }
  return 'unknown error';
}
