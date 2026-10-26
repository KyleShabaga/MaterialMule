import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  createPrintJobRequestSchema,
  putPrintersRequestSchema,
  type PrintHistoryResponse,
  type PrintJob,
  type Printer,
} from '@materialmule/shared';
import type { z } from 'zod';
import { requestIdOf } from '../auth/auth.controller.js';
import {
  CurrentUser,
  RequirePermission,
  type AuthenticatedRequest,
} from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { listPrinters, putPrinters } from './printers.js';
import {
  confirmPhysicalPrint,
  enqueuePrintJob,
  getPrintHistory,
  getPrintJob,
  PrintRequestError,
} from './print-queue.js';
import { PrintWorkerService } from './print-worker.service.js';

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      code: 'invalid_request',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function toHttpError(error: unknown): never {
  if (error instanceof PrintRequestError) {
    const body = { code: error.code, message: error.message };
    switch (error.code) {
      case 'not_found':
        throw new NotFoundException(body);
      case 'not_confirmable':
      case 'no_printer_configured':
        throw new ConflictException(body);
      default:
        throw new BadRequestException(body);
    }
  }
  throw error;
}

/** Label printing (MM-T15). Printing never changes receipts, storage units or locations. */
@Controller()
export class PrintingController {
  constructor(
    private readonly database: DatabaseService,
    private readonly printWorker: PrintWorkerService,
  ) {}

  @Post('print-jobs')
  @RequirePermission('label.print')
  async create(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<PrintJob> {
    const input = parse(createPrintJobRequestSchema, body);
    const job = await enqueuePrintJob(this.database.pool, user, input, requestIdOf(request)).catch(
      toHttpError,
    );
    this.printWorker.worker.wake();
    return job;
  }

  @Get('print-jobs/:id')
  @RequirePermission('inventory.read')
  async get(@Param('id') id: string): Promise<PrintJob> {
    const job = await getPrintJob(this.database.pool, id);
    if (!job) throw new NotFoundException({ code: 'not_found' });
    return job;
  }

  /** "Labels came out OK" / "Mark as printed". */
  @Post('print-jobs/:id/confirm-physical')
  @RequirePermission('label.print')
  @HttpCode(HttpStatus.OK)
  async confirmPhysical(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<PrintJob> {
    return confirmPhysicalPrint(this.database.pool, user, id, requestIdOf(request)).catch(
      toHttpError,
    );
  }

  /** Accepts the storage unit's UUID or its readable ID (e.g. BKT-2026-000014). */
  @Get('storage-units/:id/print-history')
  @RequirePermission('inventory.read')
  async history(@Param('id') id: string): Promise<PrintHistoryResponse> {
    const history = await getPrintHistory(this.database.pool, id);
    if (!history) throw new NotFoundException({ code: 'not_found' });
    return history;
  }

  @Get('admin/printers')
  @RequirePermission('printer.manage')
  printers(): Promise<Printer[]> {
    return listPrinters(this.database.pool);
  }

  @Put('admin/printers')
  @RequirePermission('printer.manage')
  async updatePrinters(
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<Printer[]> {
    const input = parse(putPrintersRequestSchema, body);
    const printers = await putPrinters(this.database.pool, user, input, requestIdOf(request));
    this.printWorker.worker.wake();
    return printers;
  }
}
