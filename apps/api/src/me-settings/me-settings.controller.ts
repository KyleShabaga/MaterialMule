import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  sidebarLayoutQuerySchema,
  sidebarRecordRefSchema,
  updateSidebarLayoutSchema,
  updateTableColumnsSchema,
  updateUserPreferencesSchema,
  type SidebarLayoutResponse,
  type SidebarRecordList,
  type TableColumnsResponse,
  type UserPreferencesResponse,
} from '@materialmule/shared';
import { ActiveUser, CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { MeRecordsService } from './me-records.service.js';
import { MeSettingsService } from './me-settings.service.js';

const MANAGE = 'personal_settings.manage';

/**
 * The signed-in person's own settings (Strata 1C): sidebar layout (STRATA-41), pins (STRATA-11),
 * recents (STRATA-40), preferences (STRATA-29) and table columns (STRATA-51). No route takes a
 * user ID: each reads or writes the caller's own rows. Writes, pins and recents need
 * `personal_settings.manage` (never LAB). The three reads LAB may make are `@ActiveUser()`; the
 * shared LAB account gets defaults read-only there (or, for the sidebar layout with `?personId=`,
 * the picked person's saved layout, read-only). Pending accounts get 403 `access_pending`.
 */
@Controller('me')
export class MeSettingsController {
  constructor(
    private readonly settings: MeSettingsService,
    private readonly records: MeRecordsService,
  ) {}

  @Get('sidebar-layout')
  @ActiveUser()
  sidebarLayout(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<SidebarLayoutResponse> {
    return this.settings.sidebarLayout(user, parseBody(sidebarLayoutQuerySchema, query));
  }

  @Put('sidebar-layout')
  @RequirePermission(MANAGE)
  updateSidebarLayout(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<SidebarLayoutResponse> {
    return this.settings.updateSidebarLayout(user, parseBody(updateSidebarLayoutSchema, body));
  }

  @Get('pins')
  @RequirePermission(MANAGE)
  pins(@CurrentUser() user: AuthUser): Promise<SidebarRecordList> {
    return this.records.pins(user);
  }

  @Put('pins/:kind/:id')
  @RequirePermission(MANAGE)
  pin(@CurrentUser() user: AuthUser, @Param() params: unknown): Promise<SidebarRecordList> {
    return this.records.pin(user, parseBody(sidebarRecordRefSchema, params));
  }

  @Delete('pins/:kind/:id')
  @RequirePermission(MANAGE)
  unpin(@CurrentUser() user: AuthUser, @Param() params: unknown): Promise<SidebarRecordList> {
    return this.records.unpin(user, parseBody(sidebarRecordRefSchema, params));
  }

  @Get('recents')
  @RequirePermission(MANAGE)
  recents(@CurrentUser() user: AuthUser): Promise<SidebarRecordList> {
    return this.records.recents(user);
  }

  @Post('recents')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(MANAGE)
  addRecent(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<SidebarRecordList> {
    return this.records.addRecent(user, parseBody(sidebarRecordRefSchema, body));
  }

  @Get('preferences')
  @ActiveUser()
  preferences(@CurrentUser() user: AuthUser): Promise<UserPreferencesResponse> {
    return this.settings.preferences(user);
  }

  @Patch('preferences')
  @RequirePermission(MANAGE)
  updatePreferences(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<UserPreferencesResponse> {
    return this.settings.updatePreferences(user, parseBody(updateUserPreferencesSchema, body));
  }

  @Get('table-columns')
  @ActiveUser()
  tableColumns(@CurrentUser() user: AuthUser): Promise<TableColumnsResponse> {
    return this.settings.tableColumns(user);
  }

  /** An unknown table is 400 `unknown_table` before the body is read. */
  @Put('table-columns/:tableId')
  @RequirePermission(MANAGE)
  updateTableColumns(
    @CurrentUser() user: AuthUser,
    @Param('tableId') tableId: string,
    @Body() body: unknown,
  ): Promise<TableColumnsResponse> {
    this.settings.assertKnownTable(tableId);
    return this.settings.updateTableColumns(
      user,
      tableId,
      parseBody(updateTableColumnsSchema, body),
    );
  }
}
