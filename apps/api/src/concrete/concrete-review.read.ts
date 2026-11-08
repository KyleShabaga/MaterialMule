import {
  concreteFieldReportWarningSchema,
  concreteReviewChecklist,
  type ConcreteChecklistItem,
  type ConcreteExceptionNote,
  type ConcreteFieldReportWarning,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { peopleOf, type VersionRow } from './concrete-report-lifecycle.read.js';

// MM-V2-C28: exception notes and the review checklist of a submitted version, shared by the
// review routes and C09's Mark reviewed command so both judge the same thing.

type Db = Pool | PoolClient;

/** The version's exceptions exactly as submitted (frozen in its snapshot by C09). */
export async function submittedWarnings(
  db: Db,
  versionId: string,
): Promise<ConcreteFieldReportWarning[]> {
  const { rows } = await db.query<{ warnings: unknown }>(
    `SELECT coalesce(snapshot->'warnings', '[]'::jsonb) AS warnings
     FROM concrete_report_version WHERE id = $1`,
    [versionId],
  );
  return concreteFieldReportWarningSchema.array().parse(rows[0]?.warnings ?? []);
}

export async function exceptionNotesOf(
  db: Db,
  versionId: string,
  versionNo: number,
): Promise<ConcreteExceptionNote[]> {
  const { rows } = await db.query<{
    id: string;
    code: ConcreteExceptionNote['code'];
    field: string | null;
    note: string;
    documented_by_user_id: string;
    documented_at: Date;
  }>(
    `SELECT id, code, field, note, documented_by_user_id, documented_at
     FROM concrete_report_exception_note WHERE version_id = $1 ORDER BY documented_at, id`,
    [versionId],
  );
  const people = await peopleOf(
    db,
    rows.map((r) => r.documented_by_user_id),
  );
  return rows.map((r) => ({
    id: r.id,
    versionNo,
    code: r.code,
    field: r.field,
    note: r.note,
    documentedBy: people.get(r.documented_by_user_id) ?? {
      userId: r.documented_by_user_id,
      initials: null,
      name: 'Unknown',
    },
    documentedAt: r.documented_at.toISOString(),
  }));
}

/**
 * The checklist of `version`: live rechecks count only while the report still stands as that
 * version (awaiting review), from `liveWarnings` (the report's detail as read now).
 */
export async function checklistOf(
  db: Db,
  version: Pick<VersionRow, 'id' | 'version_no' | 'state'>,
  liveWarnings: readonly ConcreteFieldReportWarning[] | null,
): Promise<ConcreteChecklistItem[]> {
  return concreteReviewChecklist({
    submitted: await submittedWarnings(db, version.id),
    live: version.state === 'submitted' ? liveWarnings : null,
    notes: await exceptionNotesOf(db, version.id, version.version_no),
  });
}
