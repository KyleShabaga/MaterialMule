import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { businessToday } from '../receiving/receipts.service.js';

/**
 * "Today" for retention and disposal (MM-T29/T30): the calendar date in BUSINESS_TIME_ZONE. Tests
 * set a fixed instant instead of waiting for real dates; production never calls `set`.
 */
@Injectable()
export class BusinessClock {
  private fixed: Date | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  now(): Date {
    return this.fixed ?? new Date();
  }

  today(): string {
    return businessToday(this.now(), this.config.BUSINESS_TIME_ZONE);
  }

  /** Test-only: pin the clock (null returns to real time). */
  set(instant: Date | null): void {
    this.fixed = instant;
  }
}
