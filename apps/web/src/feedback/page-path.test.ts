import { FEEDBACK_PAGE_MAX, submitFeedbackRequestSchema } from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import { feedbackPagePath, isTokenLike } from './page-path';

// "Include the page I was on" sends the path only (STRATA-104).

describe('feedbackPagePath', () => {
  it('drops the query string and the hash', () => {
    expect(feedbackPagePath('/sample-storage/move?search=DEMO-2601#top')).toBe(
      '/sample-storage/move',
    );
    expect(feedbackPagePath('/sign-in/microsoft/callback?code=abc&state=xyz')).toBe(
      '/sign-in/microsoft/callback',
    );
  });

  it('keeps readable IDs and UUIDs, hides token-like segments', () => {
    expect(feedbackPagePath('/sample-storage/BKT-2026-000019')).toBe(
      '/sample-storage/BKT-2026-000019',
    );
    expect(feedbackPagePath('/receiving-log/00000000-0000-4000-8000-000000000201')).toBe(
      '/receiving-log/00000000-0000-4000-8000-000000000201',
    );
    expect(feedbackPagePath('/reset/k3J9xQ2mP8vL5nR7tY4wZ1aB6cD0eF')).toBe('/reset/…');
    expect(isTokenLike('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123')).toBe(true);
    expect(isTokenLike('concrete')).toBe(false);
  });

  it('is always a path the API accepts, or null', () => {
    for (const raw of ['/a b/c', '/' + 'x'.repeat(400), '/help', '/']) {
      const page = feedbackPagePath(raw)!;
      expect(page.length).toBeLessThanOrEqual(FEEDBACK_PAGE_MAX);
      expect(submitFeedbackRequestSchema.safeParse({ kind: 'idea', text: 'x', page }).success).toBe(
        true,
      );
    }
    expect(feedbackPagePath('https://example.com/x')).toBeNull();
    expect(feedbackPagePath('//evil.example/x')).toBeNull();
    expect(feedbackPagePath('')).toBeNull();
    expect(feedbackPagePath(null)).toBeNull();
  });
});
