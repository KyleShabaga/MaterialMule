import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  receiptDraftCloseRequestSchema,
  receiptDraftDeleteRequestSchema,
  receiptDraftIdParamSchema,
  receiptDraftOwnershipQuerySchema,
  receiptDraftRegisterRequestSchema,
  type ReceiptDraftClosed,
  type ReceiptDraftDeleted,
  type ReceiptDraftOwnership,
  type ReceiptDraftOwnershipList,
} from '@materialmule/shared';
import { requestIdOf } from '../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { ReceiptDraftsService } from './receipt-drafts.service.js';

/**
 * Receiving draft ownership (STRATA-108). Metadata only: draft contents never reach the server.
 * Every route needs `receipt.draft` (LAB and every internal user). Deleting is the starter's (on
 * LAB: this LAB account with the starter picked) or a verified Lab Manager's.
 */
@Controller('receipt-drafts')
export class ReceiptDraftsController {
  constructor(private readonly drafts: ReceiptDraftsService) {}

  /**
   * `POST /api/receipt-drafts` `{ draftId, personUserId? }` → 200 ownership. Idempotent per draft
   * and account; another account's draft is 409 `draft_registered_elsewhere`, a deleted one 409
   * `draft_deleted`.
   */
  @Post()
  @HttpCode(200)
  @RequirePermission('receipt.draft')
  register(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReceiptDraftOwnership> {
    const { draftId, personUserId } = parseBody(receiptDraftRegisterRequestSchema, body);
    return this.drafts.register(user, draftId, personUserId, requestIdOf(request));
  }

  /** `GET /api/receipt-drafts?ids=a,b&personUserId=` → who started each, and canDelete. */
  @Get()
  @RequirePermission('receipt.draft')
  ownership(
    @Query() query: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<ReceiptDraftOwnershipList> {
    const { ids, personUserId } = parseBody(receiptDraftOwnershipQuerySchema, query);
    return this.drafts.ownership(user, ids, personUserId);
  }

  /**
   * `POST /api/receipt-drafts/:draftId/delete` `{ personUserId? }` → 200 when allowed (a repeat
   * too); 403 `draft_delete_forbidden` with `reason` and `starter` otherwise.
   */
  @Post(':draftId/delete')
  @HttpCode(200)
  @RequirePermission('receipt.draft')
  delete(
    @Param() params: unknown,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReceiptDraftDeleted> {
    const { draftId } = parseBody(receiptDraftIdParamSchema, params);
    const { personUserId } = parseBody(receiptDraftDeleteRequestSchema, body ?? {});
    return this.drafts.delete(user, draftId, personUserId, requestIdOf(request));
  }
  /**
   * `POST /api/receipt-drafts/:draftId/close` `{ reason: 'expired' }` → 200 (migration 0049). The
   * browser's automatic clean-up deleted this draft; best effort and idempotent. Only this
   * account's own registered draft is closed; any other ID answers `closed: false`.
   */
  @Post(':draftId/close')
  @HttpCode(200)
  @RequirePermission('receipt.draft')
  close(
    @Param() params: unknown,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReceiptDraftClosed> {
    const { draftId } = parseBody(receiptDraftIdParamSchema, params);
    parseBody(receiptDraftCloseRequestSchema, body ?? {});
    return this.drafts.close(user, draftId, requestIdOf(request));
  }
}
