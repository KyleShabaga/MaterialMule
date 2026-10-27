import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import type {
  StorageUnitDetail,
  StorageUnitHistoryPage,
  StorageUnitLookupResponse,
} from '@materialmule/shared';
import { z } from 'zod';
import { RequirePermission } from '../auth/auth.decorators.js';
import { parseBody } from '../validation/parse-body.js';
import { StorageUnitsService } from './storage-units.service.js';

/** 404 `storage_unit_not_found` when the unit doesn't exist. */
function found<T>(value: T | null): T {
  if (value === null) throw new NotFoundException({ code: 'storage_unit_not_found' });
  return value;
}

const historyQuerySchema = z.object({
  page: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number({ error: 'must be a number' }).int().min(1).max(100_000).default(1),
  ),
});

const lookupQuerySchema = z.object({
  code: z.string({ error: 'is required' }).max(200, { error: 'is too long' }),
});

/** Storage unit lookup, detail and history (MM-T12). Read-only for every active session. */
@Controller('storage-units')
export class StorageUnitsController {
  constructor(private readonly storageUnits: StorageUnitsService) {}

  /** Declared before `:suNumber` so "lookup" is never read as an ID. */
  @Get('lookup')
  @RequirePermission('inventory.read')
  async lookup(@Query() query: unknown): Promise<StorageUnitLookupResponse> {
    const { code } = parseBody(lookupQuerySchema, query);
    return found(await this.storageUnits.lookup(code));
  }

  /** Accepts the readable ID (e.g. BKT-2026-000014, any case) or the UUID. */
  @Get(':suNumber')
  @RequirePermission('inventory.read')
  async detail(@Param('suNumber') suNumber: string): Promise<StorageUnitDetail> {
    return found(await this.storageUnits.detail(suNumber));
  }

  @Get(':id/history')
  @RequirePermission('inventory.read')
  async history(@Param('id') id: string, @Query() query: unknown): Promise<StorageUnitHistoryPage> {
    const { page } = parseBody(historyQuerySchema, query);
    return found(await this.storageUnits.history(id, page));
  }
}
