import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { MeResponse } from '@trapezoid/shared';
import type { Response } from 'express';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import {
  AnySession,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from './auth.decorators.js';
import { can, type AuthUser, type Permission } from './policy.js';
import { SESSION_COOKIE, sessionCookieOptions } from './session-cookie.js';
import { SessionService } from './session.service.js';

const ALL_GLOBAL_PERMISSIONS: Permission[] = [
  'receipt.confirm',
  'receipt.draft',
  'project.create',
  'test_hole.create',
  'inventory.read',
  'label.print',
  'storage_unit.move',
  'storage_unit.correct',
  'lab_program.manage',
  'test.progress',
  'test.review',
  'storage_unit.dispose_scan',
  'test_catalog.manage',
  'program.priority.set',
  'program.reopen',
  'test.cancel',
  'retention.manage',
  'disposal.approve',
  'staff.manage',
  'session.revoke',
];

/** The request ID pino-http assigned (also returned as the x-request-id header). */
export function requestIdOf(request: AuthenticatedRequest): string | null {
  const id = (request as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

export function actorFor(user: AuthUser): AuditActor {
  return {
    userId: user.userId,
    accountType: user.accountType,
    initials: user.initials,
    name: user.displayName,
  };
}

@Controller()
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('me')
  @AnySession()
  async me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    const { rows } = await this.database.pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM session WHERE id = $1',
      [user.sessionId],
    );
    return {
      id: user.userId,
      displayName: user.displayName,
      initials: user.initials,
      accountType: user.accountType,
      // Disabled users never get this far: their sessions don't authenticate.
      status: user.status === 'pending' ? 'pending' : 'active',
      roles: user.roles,
      // Without project context, can() only grants project-scoped permissions through roles.
      permissions: ALL_GLOBAL_PERMISSIONS.filter((p) => can(user, p)),
      sessionExpiresAt: rows[0]!.expires_at.toISOString(),
    };
  }

  @Post('auth/sign-out')
  @AnySession()
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await withTransaction(this.database.pool, async (client) => {
      await client.query(
        'UPDATE session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [user.sessionId],
      );
      await recordAudit(client, {
        action: 'auth.sign_out',
        entityType: 'session',
        entityId: user.sessionId,
        actor: actorFor(user),
        requestId: requestIdOf(request),
      });
    });
    const { expires: _expires, ...options } = sessionCookieOptions(this.config, new Date());
    response.clearCookie(SESSION_COOKIE, options);
  }

  @Post('admin/users/:userId/sessions/revoke')
  @RequirePermission('session.revoke')
  async revokeUserSessions(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @CurrentUser() admin: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ revoked: number }> {
    const revoked = await withTransaction(this.database.pool, async (client) => {
      const count = await this.sessions.revokeAllForUser(userId, client);
      await recordAudit(client, {
        action: 'auth.sessions_revoked',
        entityType: 'app_user',
        entityId: userId,
        actor: actorFor(admin),
        after: { revokedSessions: count },
        requestId: requestIdOf(request),
      });
      return count;
    });
    return { revoked };
  }
}
