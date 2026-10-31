import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { MicrosoftCallbackRequest, MicrosoftSignInError } from '@materialmule/shared';
import { recordAudit, type AuditActor } from '../../../audit/audit.js';
import { APP_CONFIG } from '../../../config/config.constants.js';
import type { AppConfig } from '../../../config/env.js';
import { DatabaseService } from '../../../database/database.service.js';
import { withTransaction } from '../../../db/transaction.js';
import { mergeProfile, type GraphProfile } from '../../../profile/profile-merge.js';
import {
  PROFILE_COLUMNS,
  actorOf,
  applyGraphProfile,
  type ProfileRow,
} from '../../../profile/profile.service.js';
import { SessionService, type NewSession } from '../../session.service.js';
import { ProviderSignInFailed, type ExternalIdentityProvider } from './entra-provider.js';
import { GraphProfileError, fetchGraphProfile } from './graph-client.js';
import { MICROSOFT_PROVIDER, MICROSOFT_SETTINGS } from './microsoft.constants.js';
import type { MicrosoftSettings } from './entra-provider.js';
import { linkPreprovisionedStaff } from '../../../staff/staff.service.js';
import { MicrosoftTokenCache } from './token-cache.js';

const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;
const SYSTEM: AuditActor = { userId: null, accountType: 'system', initials: null, name: null };

export type MicrosoftSignInResult =
  { ok: true; session: NewSession; next: string } | { ok: false; reason: MicrosoftSignInError };

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Only in-app paths may be a destination after sign-in. */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    value.length <= 500
    ? value
    : '/';
}

/** Maps an error the Microsoft redirect brought back to the message the person sees. */
export function reasonForProviderError(input: MicrosoftCallbackRequest): MicrosoftSignInError {
  const description = input.errorDescription ?? '';
  if (input.errorSubcode === 'cancel') return 'cancelled';
  // AADSTS50020: user account from another tenant; AADSTS50177/AADSTS700016 similar.
  if (/AADSTS50020\b/.test(description)) return 'wrong_tenant';
  // AADSTS65004: the user declined consent; consent_required: consent is needed and wasn't given.
  if (/AADSTS65004\b/.test(description) || input.error === 'consent_required') {
    return 'consent_denied';
  }
  if (input.error === 'access_denied') return 'cancelled';
  return 'sign_in_failed';
}

/**
 * Orchestrates Microsoft sign-in (MM-T05): remembers each attempt server-side (state, nonce,
 * PKCE verifier, bound to the browser by a cookie), completes it through the provider, links the
 * identity on tenant + object ID, imports the profile from Graph, applies the bootstrap admin,
 * and issues the app session from MM-T04.
 */
@Injectable()
export class MicrosoftSignInService {
  private readonly logger = new Logger(MicrosoftSignInService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
    private readonly tokens: MicrosoftTokenCache,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional()
    @Inject(MICROSOFT_PROVIDER)
    private readonly provider: ExternalIdentityProvider | null,
    @Optional() @Inject(MICROSOFT_SETTINGS) private readonly settings: MicrosoftSettings | null,
  ) {}

  get enabled(): boolean {
    return Boolean(this.provider && this.settings);
  }

  /** Starts a sign-in. Returns the Microsoft URL and the browser-binding token for the cookie. */
  async start(
    returnTo: unknown,
    selectAccount: boolean,
  ): Promise<{ url: string; binding: string }> {
    if (!this.provider) throw new Error('Microsoft sign-in is not configured');
    const request = await this.provider.beginSignIn({ selectAccount });
    const binding = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.database.pool.query('DELETE FROM oidc_sign_in_attempt WHERE expires_at < $1', [now]);
    await this.database.pool.query(
      `INSERT INTO oidc_sign_in_attempt (provider, state_hash, browser_binding_hash, nonce,
                                         code_verifier, return_to, created_at, expires_at)
       VALUES ('microsoft', $1, $2, $3, $4, $5, $6, $7)`,
      [
        sha256(request.state),
        sha256(binding),
        request.nonce,
        request.codeVerifier,
        safeReturnTo(returnTo),
        now,
        new Date(now.getTime() + ATTEMPT_LIFETIME_MS),
      ],
    );
    return { url: request.url, binding };
  }

  async complete(
    input: MicrosoftCallbackRequest,
    binding: string | undefined,
    requestId: string | null,
  ): Promise<MicrosoftSignInResult> {
    if (!this.provider || !this.settings) return { ok: false, reason: 'not_configured' };

    // Single use: the attempt is consumed whatever happens next.
    const { rows } = await this.database.pool.query<{
      browser_binding_hash: Buffer;
      nonce: string;
      code_verifier: string;
      return_to: string;
    }>(
      `UPDATE oidc_sign_in_attempt SET consumed_at = now()
       WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING browser_binding_hash, nonce, code_verifier, return_to`,
      [sha256(input.state)],
    );
    const attempt = rows[0];
    if (!attempt || !binding || !timingSafeEqual(attempt.browser_binding_hash, sha256(binding))) {
      return this.fail('expired_attempt', requestId, {});
    }
    if (input.error || !input.code) {
      return this.fail(reasonForProviderError(input), requestId, {
        providerError: input.error ?? 'missing_code',
        providerSubcode: input.errorSubcode ?? null,
      });
    }

    let completed;
    try {
      completed = await this.provider.completeSignIn({
        code: input.code,
        state: input.state,
        expected: { state: input.state, nonce: attempt.nonce, codeVerifier: attempt.code_verifier },
      });
    } catch (error) {
      if (error instanceof ProviderSignInFailed) {
        this.logger.warn(`Microsoft sign-in refused: ${error.reason}: ${error.message}`);
        return this.fail(error.reason, requestId, {});
      }
      throw error;
    }
    const { identity } = completed;

    // Graph failure never blocks sign-in (AC5); it is recorded and the person can retry.
    let graph: GraphProfile | null = null;
    let graphStatus: number | null = null;
    try {
      graph = await fetchGraphProfile(this.settings.graphBaseUrl, completed.accessToken);
    } catch (error) {
      if (!(error instanceof GraphProfileError)) throw error;
      graphStatus = error.status;
      this.logger.warn(`Graph profile read failed: ${error.message}`);
    }

    const outcome = await withTransaction(this.database.pool, async (client) => {
      // Identity is tenant + object ID only; name and email are profile data (AC4).
      const existing = await client.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS} FROM app_user
         WHERE id = (SELECT user_id FROM identity_link
                     WHERE provider = 'microsoft' AND tenant_id = $1 AND subject = $2)
         FOR UPDATE`,
        [identity.tenantId, identity.objectId],
      );
      let row = existing.rows[0];
      const claims = { name: identity.name, preferredUsername: identity.preferredUsername };
      let created = false;

      // First sign-in for someone an admin added ahead of time (MM-T07 AC6): link that entry
      // instead of creating a new pending user. Graph's UPN is preferred over the token claim.
      const upn = graph?.userPrincipalName ?? identity.preferredUsername;
      if (!row && upn) {
        const linkedId = await linkPreprovisionedStaff(
          client,
          {
            tenantId: identity.tenantId,
            subject: identity.objectId,
            upn,
            displayName: graph?.displayName ?? identity.name ?? upn,
            givenName: graph?.givenName ?? null,
            surname: graph?.surname ?? null,
            workEmail: graph?.mail ?? null,
          },
          requestId,
        );
        if (linkedId) {
          const linked = await client.query<ProfileRow>(
            `SELECT ${PROFILE_COLUMNS} FROM app_user WHERE id = $1 FOR UPDATE`,
            [linkedId],
          );
          row = linked.rows[0];
        }
      }

      if (row?.status === 'disabled') {
        return { ok: false as const, reason: 'account_disabled' as const, userId: row.id };
      }

      if (!row) {
        const merged = mergeProfile(null, graph, claims);
        const f = merged.fields;
        const inserted = await client.query<ProfileRow>(
          `INSERT INTO app_user (display_name, given_name, surname, work_email, sign_in_username,
                                 job_title, department, office_location, account_type, status,
                                 profile_source, profile_refreshed_at, profile_refresh_failed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'personal', 'pending', $9,
                   CASE WHEN $10 THEN now() END, CASE WHEN $10 THEN NULL ELSE now() END)
           RETURNING ${PROFILE_COLUMNS}`,
          [
            f.display_name,
            f.given_name,
            f.surname,
            f.work_email,
            f.sign_in_username,
            f.job_title,
            f.department,
            f.office_location,
            merged.source,
            graph !== null,
          ],
        );
        row = inserted.rows[0]!;
        created = true;
        await client.query(
          `INSERT INTO identity_link (user_id, provider, tenant_id, subject)
           VALUES ($1, 'microsoft', $2, $3)`,
          [row.id, identity.tenantId, identity.objectId],
        );
        await recordAudit(client, {
          action: 'user.created',
          entityType: 'app_user',
          entityId: row.id,
          actor: actorOf(row),
          after: { provider: 'microsoft', status: 'pending', profileSource: merged.source },
          requestId,
        });
        if (!graph) {
          await recordAudit(client, {
            action: 'profile.refresh_failed',
            entityType: 'app_user',
            entityId: row.id,
            actor: actorOf(row),
            after: { source: 'microsoft_graph', httpStatus: graphStatus },
            requestId,
          });
        }
      } else {
        await applyGraphProfile(client, row, graph, claims, {
          actor: actorOf(row),
          requestId,
          failureStatus: graphStatus,
        });
        const reloaded = await client.query<ProfileRow>(
          `SELECT ${PROFILE_COLUMNS} FROM app_user WHERE id = $1`,
          [row.id],
        );
        row = reloaded.rows[0]!;
      }

      // Bootstrap admin (AC1): configured identity only, never "first user wins". Applies at
      // creation and while still pending; it never re-enables or re-promotes later.
      let status = row.status;
      if (
        (created || row.status === 'pending') &&
        this.isBootstrapAdmin(identity.objectId, graph)
      ) {
        await client.query(
          `UPDATE app_user SET status = 'active', updated_at = now() WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'admin')
           ON CONFLICT DO NOTHING`,
          [row.id],
        );
        await recordAudit(client, {
          action: 'user.bootstrap_admin_granted',
          entityType: 'app_user',
          entityId: row.id,
          actor: SYSTEM,
          reason: 'Matches the configured bootstrap administrator',
          before: { status: row.status },
          after: { status: 'active', roles: ['admin'] },
          requestId,
        });
        status = 'active';
      }

      const session = await this.sessions.create(row.id, 'personal', new Date(), client);
      await recordAudit(client, {
        action: 'auth.sign_in',
        entityType: 'session',
        entityId: session.sessionId,
        actor: actorOf(row),
        after: { provider: 'microsoft', expiresAt: session.expiresAt.toISOString() },
        requestId,
      });
      // No position step (MISC-06): an Admin sets positions; Not set never blocks onboarding.
      const next = status === 'pending' ? '/access-pending' : attempt.return_to;
      return { ok: true as const, session, next };
    });

    if (!outcome.ok) {
      return this.fail(outcome.reason, requestId, {}, outcome.userId);
    }
    this.tokens.set(
      outcome.session.sessionId,
      completed.accessToken,
      completed.accessTokenExpiresAt,
    );
    return { ok: true, session: outcome.session, next: outcome.next };
  }

  private isBootstrapAdmin(objectId: string, graph: GraphProfile | null): boolean {
    const configuredId = this.config.BOOTSTRAP_ADMIN_OBJECT_ID?.toLowerCase();
    if (configuredId) return configuredId === objectId;
    // UPN fallback (only when no object ID is configured): compare the directory UPN from Graph.
    const configuredUpn = this.config.BOOTSTRAP_ADMIN_UPN?.toLowerCase();
    const upn = graph?.userPrincipalName?.toLowerCase();
    return Boolean(configuredUpn && upn && configuredUpn === upn);
  }

  private async fail(
    reason: MicrosoftSignInError,
    requestId: string | null,
    detail: Record<string, unknown>,
    userId?: string,
  ): Promise<MicrosoftSignInResult> {
    await withTransaction(this.database.pool, (client) =>
      recordAudit(client, {
        action: 'auth.sign_in_failed',
        entityType: userId ? 'app_user' : 'auth',
        entityId: userId ?? null,
        actor: SYSTEM,
        after: { provider: 'microsoft', reason, ...detail },
        requestId,
      }),
    );
    return { ok: false, reason };
  }
}
