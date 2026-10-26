import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health';

describe('healthResponseSchema', () => {
  it('accepts a healthy response', () => {
    const parsed = healthResponseSchema.parse({ status: 'ok', version: '0.1.0', database: 'up' });
    expect(parsed.status).toBe('ok');
  });

  it('rejects an unknown status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'fine',
      version: '0.1.0',
      database: 'up',
    });
    expect(result.success).toBe(false);
  });
});
