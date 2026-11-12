import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  undoEligibilityQuerySchema,
  undoRequestSchema,
  undoSourceParamsSchema,
  type UndoEligibility,
  type UndoResult,
} from '@materialmule/shared';
import { requestIdOf } from '../auth/auth.controller.js';
import { ActiveUser, CurrentUser, type AuthenticatedRequest } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { UndoService } from './undo.service.js';

/**
 * Undo of reversible actions (STRATA-123). Both routes are `@ActiveUser()` (pending and disabled
 * accounts refused at the guard) and the service checks the action's own permission inside its
 * transaction: `storage_unit.move` for moves (LAB included, for its own station's move credited
 * to the same picked person), recipient-only for a notification. 200 undone (or the replay of the
 * same `idempotencyKey`); 409 `undo_blocked` with `blockedReason`. Another person's action or an
 * unknown ID is `not_found`, never revealed.
 */
@Controller('undo')
export class UndoController {
  constructor(private readonly undo: UndoService) {}

  @Get(':action/:sourceId')
  @ActiveUser()
  eligibility(
    @Param() params: unknown,
    @Query() query: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<UndoEligibility> {
    const { action, sourceId } = parseBody(undoSourceParamsSchema, params);
    const { moverUserId } = parseBody(undoEligibilityQuerySchema, query ?? {});
    return this.undo.eligibility(user, action, sourceId, moverUserId);
  }

  @Post()
  @HttpCode(200)
  @ActiveUser()
  run(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<UndoResult> {
    return this.undo.undo(user, parseBody(undoRequestSchema, body), requestIdOf(request));
  }
}
