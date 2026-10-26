import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROUTE_POLICY, type AuthenticatedRequest, type RoutePolicy } from './auth.decorators.js';
import { can } from './policy.js';
import { SESSION_COOKIE, readCookie } from './session-cookie.js';
import { SessionService } from './session.service.js';

export const CSRF_HEADER = 'x-trapezoid-csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: default deny. Resolves the session cookie, enforces the route's declared policy
 * and blocks cross-site state changes. UI visibility is never a substitute for this check.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RoutePolicy | undefined>(ROUTE_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!policy) {
      // A route without a declared policy is a bug; never let it through.
      this.logger.error(`Route without access policy: ${request.method} ${request.url}`);
      throw new ForbiddenException({ code: 'forbidden' });
    }
    if (policy.kind === 'public') {
      return true;
    }

    this.assertSameOrigin(request);

    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const user = token ? await this.sessions.authenticate(token) : null;
    if (!user) {
      throw new UnauthorizedException({ code: 'unauthenticated' });
    }
    request.user = user;

    if (policy.kind === 'session') {
      return true;
    }
    if (user.status === 'pending') {
      throw new ForbiddenException({ code: 'access_pending' });
    }
    if (policy.kind === 'active') {
      return true;
    }
    if (!can(user, policy.permission)) {
      this.logger.warn(
        `Denied ${policy.permission} to user ${user.userId} on ${request.method} ${request.url}`,
      );
      throw new ForbiddenException({ code: 'forbidden' });
    }
    return true;
  }

  /**
   * CSRF defence for cookie auth: state-changing requests need a custom header (which a
   * cross-site form can't send without a CORS preflight the API never grants) and, when the
   * browser sends an Origin, it must match the Host the request was made to.
   */
  private assertSameOrigin(request: AuthenticatedRequest): void {
    if (SAFE_METHODS.has(request.method)) {
      return;
    }
    if (request.headers[CSRF_HEADER] !== '1') {
      throw new ForbiddenException({ code: 'csrf_header_missing' });
    }
    const origin = request.headers.origin;
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        throw new ForbiddenException({ code: 'cross_origin' });
      }
      if (originHost !== request.headers.host) {
        throw new ForbiddenException({ code: 'cross_origin' });
      }
    }
  }
}
