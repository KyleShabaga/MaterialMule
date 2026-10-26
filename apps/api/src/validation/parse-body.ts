import { BadRequestException } from '@nestjs/common';
import { toFieldErrors, type FieldError, type ValidationErrorResponse } from '@trapezoid/shared';
import type { z } from 'zod';

/** A 400 listing each problem by field, in the shape receipts use too (TRP-T09). */
export function validationError(errors: FieldError[]): BadRequestException {
  return new BadRequestException({
    code: 'validation_failed',
    errors,
  } satisfies ValidationErrorResponse);
}

/**
 * Validates a request body with a shared zod schema. On failure, throws a 400 listing the fields
 * and messages only: never the submitted values.
 */
export function parseBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw validationError(toFieldErrors(result.error));
  }
  return result.data;
}
