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
import type {
  CompanyHoliday,
  CompanyHolidayList,
  ConcreteSupplier,
  ConcreteSupplierList,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { ConcreteReferenceDataService } from './concrete-reference-data.service.js';

/**
 * Concrete reference data (MM-V2-C37). Every active session reads the supplier list and the
 * holiday calendar (`inventory.read`, LAB included: field forms pick suppliers and the worklist
 * flags holidays). Suppliers are managed by Lab Managers and admins, holidays by admins; the
 * service checks again under the lock.
 */
@Controller('concrete')
export class ConcreteReferenceDataController {
  constructor(private readonly reference: ConcreteReferenceDataService) {}

  /** `GET /api/concrete/suppliers?includeInactive=`: active suppliers unless asked. */
  @Get('suppliers')
  @RequirePermission('inventory.read')
  suppliers(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<ConcreteSupplierList> {
    return this.reference.listSuppliers(query, user);
  }

  @Post('suppliers')
  @RequirePermission('concrete_settings.supplier.manage')
  createSupplier(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSupplier> {
    return this.reference.createSupplier(body, user, actorFor(user), requestIdOf(request));
  }

  @Patch('suppliers/:id')
  @RequirePermission('concrete_settings.supplier.manage')
  updateSupplier(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteSupplier> {
    return this.reference.updateSupplier(id, body, user, actorFor(user), requestIdOf(request));
  }

  /** `GET /api/concrete/holidays?year=`: the holidays in effect, by date. */
  @Get('holidays')
  @RequirePermission('inventory.read')
  holidays(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<CompanyHolidayList> {
    return this.reference.listHolidays(query, user);
  }

  @Post('holidays')
  @RequirePermission('concrete_settings.holiday.manage')
  createHoliday(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<CompanyHoliday> {
    return this.reference.createHoliday(body, user, actorFor(user), requestIdOf(request));
  }

  @Patch('holidays/:id')
  @RequirePermission('concrete_settings.holiday.manage')
  renameHoliday(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<CompanyHoliday> {
    return this.reference.renameHoliday(id, body, user, actorFor(user), requestIdOf(request));
  }

  @Post('holidays/:id/remove')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('concrete_settings.holiday.manage')
  removeHoliday(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<CompanyHoliday> {
    return this.reference.removeHoliday(id, body, user, actorFor(user), requestIdOf(request));
  }
}
