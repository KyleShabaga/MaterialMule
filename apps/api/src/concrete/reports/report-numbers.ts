import { Injectable } from '@nestjs/common';
import type { ConcreteNumberedReportKind } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

// MM-V2-C32: report numbers (design section 2). One gap-free counter per kind and year (year =
// issue date, America/Edmonton). Allocated by the server inside the issue transaction, at first
// issue only: revisions keep the number; a number is never reused. The counter row's lock
// serialises concurrent issues of the same kind and year, and a rolled-back issue rolls the
// counter back with it; the database (0031) refuses a number not taken from the counter and a
// counter raised without a number (checked at commit).

type Db = Pool | PoolClient;

export interface AllocatedReportNumber {
  id: string;
  kind: ConcreteNumberedReportKind;
  year: number;
  seq: number;
  reportNumber: string;
  /** False when the report already had its number (a revision): nothing was allocated. */
  allocated: boolean;
}

interface NumberRow {
  id: string;
  report_kind: ConcreteNumberedReportKind;
  number_year: number;
  seq: number;
  report_number: string;
}

function toResult(row: NumberRow, allocated: boolean): AllocatedReportNumber {
  return {
    id: row.id,
    kind: row.report_kind,
    year: row.number_year,
    seq: row.seq,
    reportNumber: row.report_number,
    allocated,
  };
}

/** The number a report already has, or null (never issued). */
export async function reportNumberOf(
  db: Db,
  kind: ConcreteNumberedReportKind,
  subjectId: string,
): Promise<AllocatedReportNumber | null> {
  const { rows } = await db.query<NumberRow>(
    `SELECT id, report_kind, number_year, seq, report_number FROM concrete_report_number
     WHERE report_kind = $1 AND subject_id = $2`,
    [kind, subjectId],
  );
  return rows[0] ? toResult(rows[0], false) : null;
}

/**
 * The report's number: its existing one (a revision keeps it), else the next one for the kind
 * and the issue date's year. Call it inside the issue transaction, after the issue command's own
 * locks; `client` must be in a transaction (the counter is checked at commit).
 */
export async function allocateReportNumber(
  client: PoolClient,
  input: { kind: ConcreteNumberedReportKind; projectId: string; subjectId: string; userId: string },
): Promise<AllocatedReportNumber> {
  const existing = await reportNumberOf(client, input.kind, input.subjectId);
  if (existing) return existing;
  const { rows: counter } = await client.query<{ number_year: number; last_seq: number }>(
    `INSERT INTO concrete_report_number_counter (report_kind, number_year, last_seq)
     VALUES ($1, extract(year FROM (now() AT TIME ZONE 'America/Edmonton'))::integer, 1)
     ON CONFLICT (report_kind, number_year)
       DO UPDATE SET last_seq = concrete_report_number_counter.last_seq + 1
     RETURNING number_year, last_seq`,
    [input.kind],
  );
  const { rows } = await client.query<NumberRow>(
    `INSERT INTO concrete_report_number
       (report_kind, number_year, seq, report_number, project_id, subject_id, allocated_by_user_id)
     VALUES ($1, $2, $3, '', $4, $5, $6)
     RETURNING id, report_kind, number_year, seq, report_number`,
    [
      input.kind,
      counter[0]!.number_year,
      counter[0]!.last_seq,
      input.projectId,
      input.subjectId,
      input.userId,
    ],
  );
  return toResult(rows[0]!, true);
}

/**
 * The allocator as a Nest provider, for the report kinds whose issue lives in another module
 * (C39: `allocate(client, { kind: 'strength', projectId, subjectId: strengthReportId, userId })`
 * inside its issue transaction).
 */
@Injectable()
export class ConcreteReportNumberService {
  allocate(
    client: PoolClient,
    input: {
      kind: ConcreteNumberedReportKind;
      projectId: string;
      subjectId: string;
      userId: string;
    },
  ): Promise<AllocatedReportNumber> {
    return allocateReportNumber(client, input);
  }

  numberOf(db: Db, kind: ConcreteNumberedReportKind, subjectId: string) {
    return reportNumberOf(db, kind, subjectId);
  }
}
