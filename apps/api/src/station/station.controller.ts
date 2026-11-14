import { BadRequestException, Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import {
  stationIdSchema,
  stationInboxQuerySchema,
  stationInboxSummaryQuerySchema,
  updateStationConfigSchema,
  type StationConfig,
  type StationInboxPage,
  type StationInboxSummary,
  type StationToday,
} from '@materialmule/shared';
import type { z } from 'zod';
import { requestIdOf } from '../auth/auth.controller.js';
import {
  ActiveUser,
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { StationConfigService } from './station-config.service.js';
import { StationInboxService } from './station-inbox.service.js';
import { StationTodayService } from './station-today.service.js';

const INBOX_QUERY_FIELDS = new Set(['personId', 'tab', 'filter', 'q', 'sort', 'page', 'pageSize']);

/** 400 `invalid_<field>` naming the first bad query field (never its value). */
function parseQuery<S extends z.ZodType>(schema: S, query: unknown): z.output<S> {
  const parsed = schema.safeParse(query ?? {});
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  const code =
    typeof field === 'string' && INBOX_QUERY_FIELDS.has(field)
      ? `invalid_${field}`
      : 'invalid_query';
  throw new BadRequestException({ code });
}

function stationIdOf(value: string): string {
  if (!stationIdSchema.safeParse(value).success) {
    throw new BadRequestException({ code: 'invalid_stationId' });
  }
  return value;
}

/**
 * The LAB station (Strata lane A: STRATA-20, 21, 27, 63). See docs/permissions.md "LAB station".
 * - Today: `station.today.read` (LAB, Lab Manager, Lab Technician).
 * - Config: every active session reads; saving is `station.configure` (Lab Manager with their own
 *   account; never the LAB session, whoever it picks).
 * - Inbox: `station.inbox.read` (LAB only), the picked person's Inbox with their consent,
 *   read-only. There are no station routes that change read state or decide anything.
 */
@Controller('station')
export class StationController {
  constructor(
    private readonly today: StationTodayService,
    private readonly config: StationConfigService,
    private readonly inbox: StationInboxService,
  ) {}

  @Get('today')
  @RequirePermission('station.today.read')
  counts(): Promise<StationToday> {
    return this.today.today();
  }

  @Get('config/:stationId')
  @ActiveUser()
  getConfig(@Param('stationId') stationId: string): Promise<StationConfig> {
    return this.config.get(stationIdOf(stationId));
  }

  /** `{rows, version}` → the saved config; 409 `version_conflict` with `current` when stale. */
  @Put('config/:stationId')
  @RequirePermission('station.configure')
  saveConfig(
    @Param('stationId') stationId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StationConfig> {
    const id = stationIdOf(stationId);
    const input = parseBody(updateStationConfigSchema, body);
    return this.config.save(user, id, input, requestIdOf(request));
  }

  @Get('inbox')
  @RequirePermission('station.inbox.read')
  inboxPage(@Query() query: unknown): Promise<StationInboxPage> {
    const { personId, ...inboxQuery } = parseQuery(stationInboxQuerySchema, query);
    return this.inbox.page(personId, inboxQuery);
  }

  @Get('inbox/summary')
  @RequirePermission('station.inbox.read')
  inboxSummary(@Query() query: unknown): Promise<StationInboxSummary> {
    const { personId } = parseQuery(stationInboxSummaryQuerySchema, query);
    return this.inbox.summary(personId);
  }
}
