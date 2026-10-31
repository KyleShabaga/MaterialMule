import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { effectiveJobTitle, type ProfileResponse } from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { MicrosoftTokenCache } from '../auth/providers/microsoft/token-cache.js';
import { GraphProfileError, fetchGraphProfile } from '../auth/providers/microsoft/graph-client.js';
import { MICROSOFT_SETTINGS } from '../auth/providers/microsoft/microsoft.constants.js';
import type { MicrosoftSettings } from '../auth/providers/microsoft/entra-provider.js';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import {
  mergeProfile,
  type GraphProfile,
  type IdentityClaims,
  type ProfileFields,
} from './profile-merge.js';

export interface ProfileRow extends ProfileFields {
  id: string;
  account_type: string;
  status: string;
  official_initials: string | null;
  initials_confirmed_at: Date | null;
  profile_source: ProfileResponse['source'];
  profile_refreshed_at: Date | null;
  profile_refresh_failed_at: Date | null;
  job_title_override: string | null;
}

export const PROFILE_COLUMNS = `id, account_type, status, display_name, given_name, surname,
  work_email, sign_in_username, job_title, department, office_location, official_initials,
  initials_confirmed_at, profile_source, profile_refreshed_at,
  profile_refresh_failed_at, job_title_override`;

export function profileFieldsOf(row: ProfileRow): ProfileFields {
  return {
    display_name: row.display_name,
    given_name: row.given_name,
    surname: row.surname,
    work_email: row.work_email,
    sign_in_username: row.sign_in_username,
    job_title: row.job_title,
    department: row.department,
    office_location: row.office_location,
  };
}

/**
 * Writes the outcome of a Microsoft profile read for an existing user, with its audit event, on
 * the caller's transaction. `graph` null means the read failed: known values stay and the failure
 * is recorded so the person sees a Retry. Official initials and position are never touched.
 */
export async function applyGraphProfile(
  client: PoolClient,
  row: ProfileRow,
  graph: GraphProfile | null,
  identity: IdentityClaims,
  context: { actor: AuditActor; requestId: string | null; failureStatus?: number | null },
): Promise<void> {
  if (!graph) {
    await client.query(
      'UPDATE app_user SET profile_refresh_failed_at = now(), updated_at = now() WHERE id = $1',
      [row.id],
    );
    await recordAudit(client, {
      action: 'profile.refresh_failed',
      entityType: 'app_user',
      entityId: row.id,
      actor: context.actor,
      after: { source: 'microsoft_graph', httpStatus: context.failureStatus ?? null },
      requestId: context.requestId,
    });
    return;
  }
  const merged = mergeProfile(profileFieldsOf(row), graph, identity);
  const f = merged.fields;
  await client.query(
    `UPDATE app_user
     SET display_name = $2, given_name = $3, surname = $4, work_email = $5, sign_in_username = $6,
         job_title = $7, department = $8, office_location = $9, profile_source = 'microsoft_graph',
         profile_refreshed_at = now(), profile_refresh_failed_at = NULL, updated_at = now()
     WHERE id = $1`,
    [
      row.id,
      f.display_name,
      f.given_name,
      f.surname,
      f.work_email,
      f.sign_in_username,
      f.job_title,
      f.department,
      f.office_location,
    ],
  );
  await recordAudit(client, {
    action: 'profile.refreshed',
    entityType: 'app_user',
    entityId: row.id,
    actor: context.actor,
    before: merged.changes.before,
    after: { ...merged.changes.after, source: 'microsoft_graph' },
    requestId: context.requestId,
  });
}

export function actorOf(row: ProfileRow, accountType: AuditActor['accountType'] = 'personal') {
  return {
    userId: row.id,
    accountType,
    initials: row.official_initials,
    name: row.display_name,
  } satisfies AuditActor;
}

/** The signed-in person's own profile, first-login position and Microsoft profile refresh. */
@Injectable()
export class ProfileService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tokens: MicrosoftTokenCache,
    @Optional() @Inject(MICROSOFT_SETTINGS) private readonly microsoft: MicrosoftSettings | null,
  ) {}

  private async load(userId: string, client?: PoolClient, lock = false): Promise<ProfileRow> {
    const { rows } = await (client ?? this.database.pool).query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM app_user WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [userId],
    );
    if (!rows[0]) throw new NotFoundException({ code: 'not_found' });
    return rows[0];
  }

  private async hasMicrosoftLink(userId: string): Promise<boolean> {
    const { rows } = await this.database.pool.query(
      `SELECT 1 FROM identity_link WHERE user_id = $1 AND provider = 'microsoft'`,
      [userId],
    );
    return rows.length > 0;
  }

  async get(user: AuthUser): Promise<ProfileResponse> {
    const row = await this.load(user.userId);
    return {
      displayName: row.display_name,
      givenName: row.given_name,
      surname: row.surname,
      workEmail: row.work_email,
      signInUsername: row.sign_in_username,
      jobTitle: row.job_title,
      jobTitleOverride: row.job_title_override,
      effectiveJobTitle: effectiveJobTitle(row.job_title, row.job_title_override),
      department: row.department,
      officeLocation: row.office_location,
      officialInitials: row.official_initials,
      initialsConfirmed: row.initials_confirmed_at !== null,
      source: row.profile_source,
      refreshedAt: row.profile_refreshed_at?.toISOString() ?? null,
      refreshFailedAt: row.profile_refresh_failed_at?.toISOString() ?? null,
      canRefresh: (await this.hasMicrosoftLink(user.userId)) && this.microsoft !== null,
    };
  }

  /**
   * Retry: reads Graph again with the token from this session's Microsoft sign-in (held only in
   * server memory). Without one, the person signs in with Microsoft again, which also refreshes.
   */
  async refresh(user: AuthUser, requestId: string | null): Promise<ProfileResponse> {
    if (!this.microsoft || !(await this.hasMicrosoftLink(user.userId))) {
      throw new ConflictException({ code: 'not_microsoft_account' });
    }
    const token = this.tokens.get(user.sessionId);
    if (!token) {
      throw new ConflictException({ code: 'reauth_required' });
    }
    let graph: GraphProfile | null = null;
    let failureStatus: number | null = null;
    try {
      graph = await fetchGraphProfile(this.microsoft.graphBaseUrl, token);
    } catch (error) {
      if (!(error instanceof GraphProfileError)) throw error;
      failureStatus = error.status;
    }
    await withTransaction(this.database.pool, async (client) => {
      const row = await this.load(user.userId, client, true);
      await applyGraphProfile(
        client,
        row,
        graph,
        { name: row.display_name, preferredUsername: row.sign_in_username },
        { actor: actorOf(row, user.accountType), requestId, failureStatus },
      );
    });
    return this.get(user);
  }
}
