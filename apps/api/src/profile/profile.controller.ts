import { Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { ProfileResponse } from '@materialmule/shared';
import { requestIdOf } from '../auth/auth.controller.js';
import { AnySession, CurrentUser, type AuthenticatedRequest } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ProfileService } from './profile.service.js';

/**
 * The signed-in person's own profile (MM-T05). Pending users may use these: none of them returns
 * anyone else's data. There is no self-service position (MISC-06): `POST /api/me/position` was
 * removed, so it answers 404 like any unknown route; an Admin sets positions under Staff & access.
 */
@Controller('me')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get('profile')
  @AnySession()
  profile(@CurrentUser() user: AuthUser): Promise<ProfileResponse> {
    return this.profiles.get(user);
  }

  @Post('profile/refresh')
  @AnySession()
  @HttpCode(HttpStatus.OK)
  refresh(
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProfileResponse> {
    return this.profiles.refresh(user, requestIdOf(request));
  }
}
