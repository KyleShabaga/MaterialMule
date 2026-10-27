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
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { microsoftCallbackRequestSchema, type MicrosoftSignInError } from '@materialmule/shared';
import type { Request, Response } from 'express';
import { APP_CONFIG } from '../../../config/config.constants.js';
import type { AppConfig } from '../../../config/env.js';
import { requestIdOf } from '../../auth.controller.js';
import { Public, type AuthenticatedRequest } from '../../auth.decorators.js';
import { CSRF_HEADER } from '../../auth.guard.js';
import { clientAddressOf } from '../../client-address.js';
import { SESSION_COOKIE, readCookie, sessionCookieOptions } from '../../session-cookie.js';
import { SessionService } from '../../session.service.js';
import { MicrosoftSignInRateLimit, type MicrosoftSignInEndpoint } from './microsoft-rate-limit.js';
import { MicrosoftSignInService } from './microsoft-sign-in.service.js';

/** Shown as-is by the browser: `start` is a top-level navigation, not a fetch. */
export const RATE_LIMITED_MESSAGE =
  'Too many sign-in attempts from this device. Wait a few minutes, then try again.';

/** Ties a sign-in attempt to the browser that started it (login CSRF defence). */
export const SIGN_IN_BINDING_COOKIE = 'materialmule_ms_signin';
const BINDING_PATH = '/api/auth/microsoft';

const STATUS_FOR: Record<MicrosoftSignInError, number> = {
  wrong_tenant: HttpStatus.FORBIDDEN,
  guest_account: HttpStatus.FORBIDDEN,
  account_disabled: HttpStatus.FORBIDDEN,
  cancelled: HttpStatus.UNAUTHORIZED,
  consent_denied: HttpStatus.UNAUTHORIZED,
  expired_attempt: HttpStatus.BAD_REQUEST,
  not_configured: HttpStatus.NOT_FOUND,
  sign_in_failed: HttpStatus.UNAUTHORIZED,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
};

/**
 * Microsoft sign-in (MM-T05). `start` sends the browser to Microsoft; Microsoft redirects to
 * the web route /sign-in/microsoft/callback, which posts the result here. Both 404 while the
 * provider isn't configured.
 */
@Controller('auth/microsoft')
export class MicrosoftAuthController {
  private readonly logger = new Logger(MicrosoftAuthController.name);

  constructor(
    private readonly signIn: MicrosoftSignInService,
    private readonly sessions: SessionService,
    private readonly rateLimit: MicrosoftSignInRateLimit,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Counts the request against its client address (MM-T48). Returns the seconds to wait when
   * the address is over the limit. Denials are logged, not audited, like T04's 403s.
   */
  private limited(endpoint: MicrosoftSignInEndpoint, request: Request): number | null {
    const address = clientAddressOf(request);
    const decision = this.rateLimit.hit(endpoint, address);
    if (decision.allowed) return null;
    this.logger.warn(`Rate-limited Microsoft sign-in ${endpoint} from ${address ?? 'unknown'}`);
    return decision.retryAfterSeconds;
  }

  @Get('start')
  @Public()
  async start(
    @Query('returnTo') returnTo: unknown,
    @Query('switch') switchUser: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const retryAfter = this.limited('start', request);
    if (retryAfter !== null) {
      response
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .setHeader('Retry-After', String(retryAfter))
        .type('text/plain')
        .send(RATE_LIMITED_MESSAGE);
      return;
    }
    if (!this.signIn.enabled) {
      throw new NotFoundException({ code: 'not_configured' });
    }
    // "Switch user" (and any shared station) forces Microsoft's account picker.
    const { url, binding } = await this.signIn.start(returnTo, switchUser === '1');
    response.cookie(SIGN_IN_BINDING_COOKIE, binding, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.APP_ENV === 'production',
      path: BINDING_PATH,
      maxAge: 10 * 60 * 1000,
    });
    response.redirect(HttpStatus.FOUND, url);
  }

  @Post('callback')
  @Public()
  @HttpCode(HttpStatus.OK)
  async callback(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ next: string }> {
    const retryAfter = this.limited('callback', request);
    if (retryAfter !== null) {
      response.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        { code: 'rate_limited', message: RATE_LIMITED_MESSAGE, retryAfterSeconds: retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // Public routes skip the guard's CSRF check, so apply it here: signing in is a state change.
    if (request.headers[CSRF_HEADER] !== '1') {
      throw new ForbiddenException({ code: 'csrf_header_missing' });
    }
    if (!this.signIn.enabled) {
      throw new NotFoundException({ code: 'not_configured' });
    }
    const parsed = microsoftCallbackRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid_request' });
    }
    const binding = readCookie(request.headers.cookie, SIGN_IN_BINDING_COOKIE);
    response.clearCookie(SIGN_IN_BINDING_COOKIE, { path: BINDING_PATH });

    const result = await this.signIn.complete(parsed.data, binding, requestIdOf(request));
    if (!result.ok) {
      const status = STATUS_FOR[result.reason];
      if (status === HttpStatus.UNAUTHORIZED) {
        throw new UnauthorizedException({ code: result.reason });
      }
      if (status === HttpStatus.FORBIDDEN) throw new ForbiddenException({ code: result.reason });
      if (status === HttpStatus.NOT_FOUND) throw new NotFoundException({ code: result.reason });
      throw new BadRequestException({ code: result.reason });
    }
    // Whoever was signed in on this browser before is signed out (shared devices).
    const previous = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (previous) {
      await this.sessions.revokeToken(previous);
    }
    response.cookie(
      SESSION_COOKIE,
      result.session.token,
      sessionCookieOptions(this.config, result.session.expiresAt),
    );
    return { next: result.next };
  }
}
