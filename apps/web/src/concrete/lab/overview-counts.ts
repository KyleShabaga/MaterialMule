import {
  concreteReceivingQueueSchema,
  concreteReviewQueueSchema,
  concreteWorklistSchema,
  type ConcreteReceivingQueue,
  type ConcreteReviewQueue,
  type ConcreteWorklist,
} from '@materialmule/shared';
import type { z } from 'zod';
import { apiFetch } from '../../api/client';

// STRATA-93: the Concrete overview's counts, read from the three lists they open (the receiving
// queue, the Breaks worklist and the review queue). Each source answers on its own, so one that
// fails or that this account can't read shows as unavailable while the others stay current; a
// count is never shown as 0 when it wasn't read.

export type SourceLoad<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T }
  /** The server refused this account (401/403): the count is not this person's to see. */
  | { state: 'forbidden' }
  /** The list exists but isn't turned on in this installation (feature flag). */
  | { state: 'off' }
  | { state: 'failed' };

async function read<T>(url: string, schema: z.ZodType<T>): Promise<SourceLoad<T>> {
  try {
    const response = await apiFetch(url);
    if (response.status === 401 || response.status === 403) return { state: 'forbidden' };
    if (!response.ok) return { state: 'failed' };
    const parsed = schema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { state: 'ready', data: parsed.data } : { state: 'failed' };
  } catch {
    return { state: 'failed' };
  }
}

/** Awaiting pickup and awaiting receiving (the queue reports both counts on every stage). */
export const readReceivingCounts = (): Promise<SourceLoad<ConcreteReceivingQueue>> =>
  read(
    '/api/concrete/receiving-queue?stage=awaiting_pickup&pageSize=1',
    concreteReceivingQueueSchema,
  );

/** Every Breaks view's count; the Exceptions view reads no page of rows. */
export const readWorklistCounts = (): Promise<SourceLoad<ConcreteWorklist>> =>
  read('/api/concrete/lab-worklist?view=exceptions', concreteWorklistSchema);

/** Awaiting review and awaiting issuance. */
export const readReviewCounts = (): Promise<SourceLoad<ConcreteReviewQueue>> =>
  read('/api/concrete/review-queue?pageSize=1', concreteReviewQueueSchema);
