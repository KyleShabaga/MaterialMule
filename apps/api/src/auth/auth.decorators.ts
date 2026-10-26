import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser, Permission } from './policy.js';

/**
 * Every route must declare exactly one access policy; the global AuthGuard denies routes that
 * don't, and the route-coverage test fails the build.
 */
export type RoutePolicy =
  | { kind: 'public' }
  /** Any session, including pending users (e.g. /api/me, sign-out). */
  | { kind: 'session' }
  /** Any active user; the handler checks a project-scoped permission itself with can(). */
  | { kind: 'active' }
  | { kind: 'permission'; permission: Permission };

export const ROUTE_POLICY = 'materialmule:route-policy';

export const Public = () => SetMetadata(ROUTE_POLICY, { kind: 'public' } satisfies RoutePolicy);
export const AnySession = () =>
  SetMetadata(ROUTE_POLICY, { kind: 'session' } satisfies RoutePolicy);
export const ActiveUser = () => SetMetadata(ROUTE_POLICY, { kind: 'active' } satisfies RoutePolicy);
export const RequirePermission = (permission: Permission) =>
  SetMetadata(ROUTE_POLICY, { kind: 'permission', permission } satisfies RoutePolicy);

export type AuthenticatedRequest = Request & { user?: AuthUser };

/** The signed-in user on a route that requires a session. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.user) {
    throw new Error('CurrentUser used on a route without an authenticated session');
  }
  return request.user;
});
