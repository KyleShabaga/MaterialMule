import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  labPasswordResetRequestSchema,
  labSignInRequestSchema,
  type LabAccountResponse,
} from '@trapezoid/shared';
import type { Response } from 'express';
import { APP_CONFIG } from '../../../config/config.constants.js';
import type { AppConfig } from '../../../config/env.js';
import { actorFor, requestIdOf } from '../../auth.controller.js';
import {
  CurrentUser,
  Public,
  RequirePermission,
  type AuthenticatedRequest,
} from '../../auth.decorators.js';
import { CSRF_HEADER } from '../../auth.guard.js';
import type { AuthUser } from '../../policy.js';
import { SESSION_COOKIE, sessionCookieOptions } from '../../session-cookie.js';
import { LabAuthService } from './lab-auth.service.js';

/** The connecting address, for rate limiting. The API is reached directly on the LAN (D25). */
function clientAddressOf(request: AuthenticatedRequest): string | null {
  return request.socket.remoteAddress ?? null;
}

/** `POST /api/auth/lab/sign-in`: the shared receiving station signs in as LAB (TRP-T06). */
@Controller('auth/lab')
export class LabAuthController {
  constructor(
    private readonly lab: LabAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

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
    const parsed = labSignInRequestSchema.safeParse(body);
    if (!parsed.success) {
      // No field values in the response: one of them is a password.
      throw new BadRequestException({ code: 'invalid_request' });
    }
    const result = await this.lab.signIn({
      username: parsed.data.username,
      password: parsed.data.password,
      clientAddress: clientAddressOf(request),
      requestId: requestIdOf(request),
    });
    if (result.outcome === 'locked') {
      response.setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new HttpException(
        { code: 'locked_out', retryAfterSeconds: result.retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (result.outcome === 'invalid') {
      // The same answer for an unknown username, a wrong password or a LAB without a password.
      throw new UnauthorizedException({ code: 'invalid_credentials' });
    }
    response.cookie(
      SESSION_COOKIE,
      result.session.token,
      sessionCookieOptions(this.config, result.session.expiresAt),
    );
  }
}

/** Administration of the LAB account. Lives in the staff admin area (TRP-T07). */
@Controller('admin/lab')
export class LabAdminController {
  constructor(private readonly lab: LabAuthService) {}

  @Get()
  @RequirePermission('staff.manage')
  account(): Promise<LabAccountResponse> {
    return this.lab.account();
  }

  /** Sets or resets the LAB password; every LAB session stops working on its next request. */
  @Post('password')
  @RequirePermission('staff.manage')
  @HttpCode(HttpStatus.OK)
  async setPassword(
    @Body() body: unknown,
    @CurrentUser() admin: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ revokedSessions: number }> {
    const parsed = labPasswordResetRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_password',
        // Hand-written messages only; none contains the submitted value.
        message: parsed.error.issues[0]?.message ?? 'The password is not acceptable.',
      });
    }
    return this.lab.setPassword(parsed.data.newPassword, actorFor(admin), requestIdOf(request));
  }
}
