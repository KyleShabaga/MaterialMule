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
  assignedAirMeterQuerySchema,
  concreteEquipmentListQuerySchema,
  concreteEquipmentUseQuerySchema,
  type AssignedAirMeter,
  type ConcreteEquipmentDetail,
  type ConcreteEquipmentList,
  type ConcreteEquipmentUse,
} from '@materialmule/shared';
import { actorFor, requestIdOf } from '../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { parseBody } from '../validation/parse-body.js';
import { ConcreteEquipmentService } from './concrete-equipment.service.js';

/**
 * Concrete equipment register (MM-V2-C27, CD-44/CD-45). Every active session reads it
 * (`inventory.read`, LAB included: field reports autofill the air meter and the testing table
 * uses the machine). The testing machine's routes need `concrete_settings.testing_machine.manage`
 * and the air meters' `concrete_settings.air_meter.manage`; the service checks again under the
 * lock, and treats an id of the other kind as not found.
 */
@Controller('concrete')
export class ConcreteEquipmentController {
  constructor(private readonly equipment: ConcreteEquipmentService) {}

  /** `GET /api/concrete/equipment?kind=&includeRetired=`: not retired unless asked. */
  @Get('equipment')
  @RequirePermission('inventory.read')
  list(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<ConcreteEquipmentList> {
    return this.equipment.list(parseBody(concreteEquipmentListQuerySchema, query), user);
  }

  @Get('equipment/:id')
  @RequirePermission('inventory.read')
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<ConcreteEquipmentDetail> {
    return this.equipment.detail(id, user);
  }

  /** What using it on `on` (default today) flags, for the records that use equipment. */
  @Get('equipment/:id/use-check')
  @RequirePermission('inventory.read')
  useCheck(@Param('id') id: string, @Query() query: unknown): Promise<ConcreteEquipmentUse> {
    return this.equipment.useCheck(id, parseBody(concreteEquipmentUseQuerySchema, query).on);
  }

  /** The field-report autofill: the technician's assigned air meter, when exactly one. */
  @Get('air-meters/assigned')
  @RequirePermission('inventory.read')
  assigned(@Query() query: unknown, @CurrentUser() user: AuthUser): Promise<AssignedAirMeter> {
    const input = parseBody(assignedAirMeterQuerySchema, query);
    return this.equipment.assignedAirMeter(input.technicianUserId, input.on, user);
  }

  // Testing machine (CD-44): Lab Manager.

  @Post('testing-machine')
  @RequirePermission('concrete_settings.testing_machine.manage')
  registerMachine(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteEquipmentDetail> {
    return this.equipment.create(
      'testing_machine',
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }

  @Patch('testing-machine/:id')
  @RequirePermission('concrete_settings.testing_machine.manage')
  updateMachine(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteEquipmentDetail> {
    return this.equipment.update(
      'testing_machine',
      id,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }

  @Post('testing-machine/:id/calibrations')
  @RequirePermission('concrete_settings.testing_machine.manage')
  calibrateMachine(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteEquipmentDetail> {
    return this.equipment.recordCalibration(
      'testing_machine',
      id,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }

  @Post('testing-machine/:id/calibrations/:calibrationId/void')
  @RequirePermission('concrete_settings.testing_machine.manage')
  @HttpCode(HttpStatus.OK)
  voidMachineCalibration(
    @Param('id') id: string,
    @Param('calibrationId') calibrationId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteEquipmentDetail> {
    return this.equipment.voidCalibration(
      'testing_machine',
      id,
      calibrationId,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }

  // Air meters (CD-45): Lab Manager (proposal, owner to confirm).

  @Post('air-meters')
  @RequirePermission('concrete_settings.air_meter.manage')
  registerAirMeter(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteEquipmentDetail> {
    return this.equipment.create('air_meter', body, user, actorFor(user), requestIdOf(request));
  }

  @Patch('air-meters/:id')
  @RequirePermission('concrete_settings.air_meter.manage')
  updateAirMeter(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteEquipmentDetail> {
    return this.equipment.update('air_meter', id, body, user, actorFor(user), requestIdOf(request));
  }

  @Post('air-meters/:id/calibrations')
  @RequirePermission('concrete_settings.air_meter.manage')
  calibrateAirMeter(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteEquipmentDetail> {
    return this.equipment.recordCalibration(
      'air_meter',
      id,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }

  @Post('air-meters/:id/calibrations/:calibrationId/void')
  @RequirePermission('concrete_settings.air_meter.manage')
  @HttpCode(HttpStatus.OK)
  voidAirMeterCalibration(
    @Param('id') id: string,
    @Param('calibrationId') calibrationId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConcreteEquipmentDetail> {
    return this.equipment.voidCalibration(
      'air_meter',
      id,
      calibrationId,
      body,
      user,
      actorFor(user),
      requestIdOf(request),
    );
  }
}
