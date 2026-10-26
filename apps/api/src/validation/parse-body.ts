import { BadRequestException } from '@nestjs/common';
import type { ValidationErrorResponse } from '@trapezoid/shared';
import { z } from 'zod';

/** A 400 with messages keyed by field name, in the shape the web forms read. */
export function validationError(fieldErrors: Record<string, string[]>): BadRequestException {
  return new BadRequestException({
    code: 'validation_failed',
    fieldErrors,
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
  if (result.success) {
    return result.data;
  }
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : '_';
    (fieldErrors[field] ??= []).push(issue.message);
  }
  throw validationError(fieldErrors);
}
