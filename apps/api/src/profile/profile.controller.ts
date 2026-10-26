import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { positionRequestSchema, type ProfileResponse } from '@trapezoid/shared';
import { requestIdOf } from '../auth/auth.controller.js';
import { AnySession, CurrentUser, type AuthenticatedRequest } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ProfileService } from './profile.service.js';

/**
 * The signed-in person's own profile (TRP-T05). Pending users may use these: setting a position
 * is part of onboarding before approval, and none of them returns anyone else's data.
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

  @Post('position')
  @AnySession()
  @HttpCode(HttpStatus.NO_CONTENT)
  async setPosition(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const parsed = positionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid_position' });
    }
    await this.profiles.setPosition(user, parsed.data.position, requestIdOf(request));
  }
}
