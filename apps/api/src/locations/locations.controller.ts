import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  createLocationLabelRequestSchema,
  createLocationRequestSchema,
  locationListQuerySchema,
  retireLocationRequestSchema,
  scanResolveQuerySchema,
  updateLocationRequestSchema,
  type LocationDetail,
  type LocationLabelPreview,
  type PrintJob,
  type ScanResolveResponse,
  type StorageLocation,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { enqueueLocationLabelJob } from '../printing/print-queue.js';
import { toHttpError } from '../printing/printing.controller.js';
import { PrintWorkerService } from '../printing/print-worker.service.js';
import { parseBody } from '../validation/parse-body.js';
import { LocationsService } from './locations.service.js';

/**
 * Storage locations (MM-T37). Every active session, LAB included, reads locations and resolves
 * scans (`inventory.read`). Only admins and Lab Managers add, edit and retire them
 * (`location.manage`, Kyle 2026-10-26): LAB never can, whoever is selected at the station.
 * Printing a location label uses the existing `label.print` permission.
 */
@Controller()
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly database: DatabaseService,
    private readonly printWorker: PrintWorkerService,
  ) {}

  /** `GET /api/locations?search=&includeRetired=`: active only unless retired are asked for. */
  @Get('locations')
  @RequirePermission('inventory.read')
  list(@Query() query: unknown): Promise<StorageLocation[]> {
    return this.locations.list(parseBody(locationListQuerySchema, query));
  }

  @Get('locations/:id')
  @RequirePermission('inventory.read')
  detail(@Param('id') id: string): Promise<LocationDetail> {
    return this.locations.detail(id);
  }

  @Get('locations/:id/label/preview')
  @RequirePermission('inventory.read')
  labelPreview(@Param('id') id: string): Promise<LocationLabelPreview> {
    return this.locations.labelPreview(id);
  }

  /** 201 with the location; 409 `location_code_exists` when the code is taken (any case). */
  @Post('locations')
  @RequirePermission('location.manage')
  create(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StorageLocation> {
    const input = parseBody(createLocationRequestSchema, body);
    return this.locations.create(input, actorFor(user), requestIdOf(request));
  }

  @Patch('locations/:id')
  @RequirePermission('location.manage')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StorageLocation> {
    const input = parseBody(updateLocationRequestSchema, body);
    return this.locations.update(id, input, actorFor(user), requestIdOf(request));
  }

  @Post('locations/:id/retire')
  @RequirePermission('location.manage')
  @HttpCode(HttpStatus.OK)
  retire(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<StorageLocation> {
    const input = parseBody(retireLocationRequestSchema, body);
    return this.locations.retire(id, input, actorFor(user), requestIdOf(request));
  }

  /** Queue the location's label (print or reprint) on the server-side print queue. */
  @Post('locations/:id/labels')
  @RequirePermission('label.print')
  async printLabel(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<PrintJob> {
    const input = parseBody(createLocationLabelRequestSchema, body);
    const job = await enqueueLocationLabelJob(
      this.database.pool,
      user,
      id,
      input,
      requestIdOf(request),
    ).catch(toHttpError);
    this.printWorker.worker.wake();
    return job;
  }

  /** `GET /api/scan/resolve?payload=`: location label, storage unit sticker or unknown. */
  @Get('scan/resolve')
  @RequirePermission('inventory.read')
  resolve(@Query() query: unknown): Promise<ScanResolveResponse> {
    const { payload } = parseBody(scanResolveQuerySchema, query);
    return this.locations.resolveScan(payload);
  }
}
