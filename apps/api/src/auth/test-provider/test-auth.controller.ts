import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { recordAudit } from '../../audit/audit.js';
import { APP_CONFIG } from '../../config/config.constants.js';
import type { AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { withTransaction } from '../../db/transaction.js';
import { actorFor, requestIdOf } from '../auth.controller.js';
import { Public, type AuthenticatedRequest } from '../auth.decorators.js';
import { CSRF_HEADER } from '../auth.guard.js';
import type { AccountStatus, AccountType } from '../policy.js';
import { SESSION_COOKIE, sessionCookieOptions } from '../session-cookie.js';
import { SessionService } from '../session.service.js';
import { TEST_FIXTURES } from './fixtures.js';

const signInSchema = z.object({ fixtureKey: z.string().min(1).max(40) });

export interface TestFixtureView {
  key: string;
  displayName: string;
  initials: string | null;
  roles: string[];
  summary: string;
}

/**
 * Development/test-only sign-in (TRP-T33). AppModule registers this controller only when
 * APP_ENV is development or test AND ENABLE_TEST_AUTH=true; production can't even start with
 * the flag set, so these routes 404 there. No passwords, tokens or Microsoft calls are involved.
 */
@Controller('auth/test')
export class TestAuthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('fixtures')
  @Public()
  async fixtures(): Promise<TestFixtureView[]> {
    const { rows } = await this.database.pool.query<{
      subject: string;
      display_name: string;
      official_initials: string | null;
      roles: string[];
    }>(
      `SELECT l.subject, u.display_name, u.official_initials,
              COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
       FROM identity_link l
       JOIN app_user u ON u.id = l.user_id
       LEFT JOIN role_assignment r ON r.user_id = u.id
       WHERE l.provider = 'test' AND u.status = 'active'
       GROUP BY l.subject, u.display_name, u.official_initials`,
    );
    const bySubject = new Map(rows.map((row) => [row.subject, row]));
    return TEST_FIXTURES.flatMap((fixture) => {
      const row = bySubject.get(fixture.key);
      return row
        ? [
            {
              key: fixture.key,
              displayName: row.display_name,
              initials: row.official_initials,
              roles: row.roles,
              summary: fixture.summary,
            },
          ]
        : [];
    });
  }

  @Post('sign-in')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  async signIn(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    // Public routes skip the guard's CSRF check, so apply it here: signing in is a state change.
    if (request.headers[CSRF_HEADER] !== '1') {
      throw new ForbiddenException({ code: 'csrf_header_missing' });
    }
    const parsed = signInSchema.safeParse(body);
    if (!parsed.success) {
      throw new NotFoundException({ code: 'unknown_fixture' });
    }
    const { rows } = await this.database.pool.query<{
      id: string;
      account_type: AccountType;
      status: AccountStatus;
      display_name: string;
      official_initials: string | null;
    }>(
      `SELECT u.id, u.account_type, u.status, u.display_name, u.official_initials
       FROM identity_link l JOIN app_user u ON u.id = l.user_id
       WHERE l.provider = 'test' AND l.tenant_id = '' AND l.subject = $1`,
      [parsed.data.fixtureKey],
    );
    const user = rows[0];
    if (!user || user.status !== 'active' || user.account_type !== 'test') {
      throw new NotFoundException({ code: 'unknown_fixture' });
    }

    const session = await this.sessions.create(user.id, user.account_type);
    await withTransaction(this.database.pool, (client) =>
      recordAudit(client, {
        action: 'auth.test_sign_in',
        entityType: 'session',
        entityId: session.sessionId,
        actor: actorFor({
          userId: user.id,
          sessionId: session.sessionId,
          accountType: user.account_type,
          status: user.status,
          roles: [],
          displayName: user.display_name,
          initials: user.official_initials,
        }),
        requestId: requestIdOf(request),
      }),
    );
    response.cookie(
      SESSION_COOKIE,
      session.token,
      sessionCookieOptions(this.config, session.expiresAt),
    );
  }
}

/** True when the fixture sign-in routes should exist. */
export function testAuthEnabled(config: AppConfig): boolean {
  return config.ENABLE_TEST_AUTH && config.APP_ENV !== 'production';
}
