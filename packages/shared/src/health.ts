import { z } from 'zod';

/** Response body of `GET /api/health`. HTTP 200 when status is `ok`, 503 when `degraded`. */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  database: z.enum(['up', 'down']),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
