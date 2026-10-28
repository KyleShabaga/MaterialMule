import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import {
  moveRequestSchema,
  resolveLocationConflictRequestSchema,
  type LocationConflictDetail,
  type MoveConflictResponse,
  type MoveSavedResponse,
  type ResolveLocationConflictResponse,
} from '@materialmule/shared';
import type { Response } from 'express';
import { requestIdOf } from '../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { MovesService } from './moves.service.js';

/**
 * Storage moves and location conflicts (MM-T28). LAB and every active personal account record
 * moves (`storage_unit.move`, owner decision 2026-10-25); only a personal account confirms the
 * actual location of a conflicted unit (`location_conflict.resolve`, D29). A person chosen at a
 * LAB station is attribution only and never lends their permissions.
 */
@Controller()
export class MovesController {
  constructor(private readonly moves: MovesService) {}

  /**
   * 201 saved; 200 the recorded outcome of a retry (`replayed: true`); 409 `location_conflict`
   * with the committed attempt and conflict IDs. See docs/database.md "Storage moves".
   */
  @Post('moves')
  @RequirePermission('storage_unit.move')
  async move(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MoveSavedResponse | MoveConflictResponse> {
    const input = parseBody(moveRequestSchema, body);
    const result = await this.moves.move(input, user, requestIdOf(request));
    response.status(result.status);
    return result.body;
  }

  @Get('location-conflicts/:id')
  @RequirePermission('inventory.read')
  conflict(@Param('id') id: string): Promise<LocationConflictDetail> {
    return this.moves.conflict(id);
  }

  /** 201 resolved; 200 replay of the same `clientResolutionId`; 409 stale or already resolved. */
  @Post('location-conflicts/:id/resolve')
  @RequirePermission('location_conflict.resolve')
  async resolve(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ResolveLocationConflictResponse> {
    const input = parseBody(resolveLocationConflictRequestSchema, body);
    const result = await this.moves.resolve(id, input, user, requestIdOf(request));
    response.status(result.replayed ? 200 : 201);
    return result;
  }
}
