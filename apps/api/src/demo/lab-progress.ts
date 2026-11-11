// Soils part of `npm run db:seed:demo`: brings one lab test to its demo state, resuming whatever
// an interrupted earlier run left (seed-cli.ts).
import { randomUUID } from 'node:crypto';
import type { ReviewState } from '@materialmule/shared';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface LabActor {
  get(path: string): Promise<Json>;
  post(path: string, body?: unknown): Promise<Json>;
}

export type Target = 'requested' | 'in_progress' | 'completed' | 'review' | 'returned' | 'accepted';
const PROGRESS = ['requested', 'in_progress', 'completed', 'review'];

export interface Crew {
  tech: LabActor;
  reviewer: LabActor;
  lead: LabActor;
}

const key = () => randomUUID();

/**
 * Brings one test (line `lineIndex`, test `code` of `program`) from its current status and review
 * sub-state to `target`, so a rerun only does what is left: a test stopped after entering review
 * still gets its review decision, and one stopped after review complete still gets accepted.
 * Accepted, cancelled and returned tests are left as they are. Completing a test that covers
 * Shelby tubes or bulk-sample buckets names the first such unit as the one tested.
 */
export async function bringTo(
  program: Json,
  lineIndex: number,
  code: string,
  target: Target,
  crew: Crew,
  returnComment = 'Tare weight missing on sheet 2',
): Promise<void> {
  const line = (program.lines as Json[])[lineIndex]!;
  const test = (line.requests as Json[]).find((r) => r.code === code)!;
  // The program's detail has no review sub-state; its work view does, and is current.
  const work = await crew.tech.get(`/lab-programs/${program.id as string}/work`);
  const now = (work.requests as Json[]).find((r) => r.testRequestId === test.id) ?? {
    status: test.status,
    version: test.version,
    reviewState: null,
  };
  const startedAt = now.status as string;
  if (startedAt === 'accepted' || startedAt === 'cancelled') return;
  const goal = target === 'returned' || target === 'accepted' ? 'review' : target;
  let version = now.version as number;
  let reviewState = (startedAt === 'review' ? now.reviewState : null) as ReviewState | null;
  for (const step of PROGRESS.slice(PROGRESS.indexOf(startedAt) + 1, PROGRESS.indexOf(goal) + 1)) {
    const special = (line.coverage as Json[]).find(
      // Only tracked units are named as tested: never a bucket or a core box.
      (unit) =>
        unit.included && (unit.unitType === 'shelby_tube' || unit.unitType === 'bulk_container'),
    );
    version = (
      await crew.tech.post(`/test-requests/${test.id as string}/status`, {
        to: step,
        version,
        idempotencyKey: key(),
        ...(step === 'completed' && special
          ? { testedStorageUnitIds: [special.storageUnitId] }
          : {}),
      })
    ).version as number;
    if (step === 'review') reviewState = 'awaiting_review';
  }
  if (target === goal) return;

  if (target === 'returned') {
    // Already returned (or corrected since) is done; a completed review isn't reopened.
    if (reviewState !== 'awaiting_review') return;
    await crew.reviewer.post(`/test-requests/${test.id as string}/review`, {
      action: 'return',
      comment: returnComment,
      version,
      idempotencyKey: key(),
    });
    return;
  }

  // target === 'accepted'. A returned test waits for its correction: left as it is.
  if (reviewState === 'returned') return;
  if (reviewState === 'awaiting_review' || reviewState === 'correction_done') {
    version = (
      await crew.reviewer.post(`/test-requests/${test.id as string}/review`, {
        action: 'complete',
        version,
        idempotencyKey: key(),
      })
    ).version as number;
  }
  await crew.lead.post(`/test-requests/${test.id as string}/accept`, {
    version,
    idempotencyKey: key(),
  });
}
