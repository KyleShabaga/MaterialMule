import { Injectable } from '@nestjs/common';
import {
  CONCRETE_RECEIVING_STAGES,
  CONCRETE_SEARCH_MATCHES,
  CONCRETE_SEARCH_MIN_LENGTH,
  concreteReceivingQueueQuerySchema,
  concreteSearchQuerySchema,
  concreteSearchTerms,
  type ConcreteReceivingQueue,
  type ConcreteReceivingQueueRow,
  type ConcreteReceivingStage,
  type ConcreteSearch,
  type ConcreteSearchMatch,
  type ConcreteSearchResult,
} from '@materialmule/shared';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { parseBody } from '../validation/parse-body.js';
import { peopleOf } from './concrete-report-lifecycle.read.js';

/**
 * Each specimen's receiving stage, the same rule as C06's set receiving read: received (a
 * receipt) or a resolved Missing disposition is no longer waiting; a completed pickup is awaiting
 * receiving; anything else is awaiting pickup. Only specimens that can be collected count: a set
 * that isn't Void, on a report that isn't Void, with a known casting time.
 */
const SPECIMEN_STAGE = `
  SELECT sp.set_id, sp.letter,
         CASE WHEN rc.id IS NOT NULL OR mx.resolved THEN NULL
              WHEN pk.completed THEN 'awaiting_receiving'
              ELSE 'awaiting_pickup' END AS stage
  FROM concrete_specimen sp
  JOIN concrete_specimen_set st ON st.id = sp.set_id
  JOIN concrete_field_report r ON r.id = st.field_report_id
  LEFT JOIN concrete_specimen_pickup pk ON pk.specimen_id = sp.id
  LEFT JOIN concrete_specimen_receipt rc ON rc.specimen_id = sp.id
  LEFT JOIN LATERAL (
    SELECT true AS resolved FROM concrete_receiving_exception e
    WHERE e.kind = 'missing' AND e.specimen_id = sp.id AND e.resolved_at IS NOT NULL LIMIT 1
  ) mx ON true
  WHERE st.voided_at IS NULL AND r.workflow_state <> 'void' AND r.cast_at IS NOT NULL
    AND ($1::uuid IS NULL OR sp.project_id = $1)`;

/** One row per set and stage with the set's letters in that stage. */
const SET_STAGE = `
  SELECT s.set_id, s.stage, array_agg(s.letter ORDER BY s.letter) AS letters
  FROM (${SPECIMEN_STAGE}) s WHERE s.stage IS NOT NULL GROUP BY s.set_id, s.stage`;

interface QueueRowSql {
  set_id: string;
  field_report_id: string;
  project_id: string;
  project_number: string;
  project_name: string;
  temporary_id: string | null;
  permanent_id: string | null;
  cast_at: Date;
  technician_user_id: string | null;
  mine: boolean;
  letters: string[];
  specimen_count: number;
  workflow_state: string;
}

/** Each search branch reads at most this many candidates before ranking (bounded). */
const BRANCH_LIMIT = 500;

interface SearchCandidate {
  report_id: string;
  rank: number;
  matches: ConcreteSearchMatch[];
  set_ids: string[] | null;
}

interface SearchReportSql {
  id: string;
  project_id: string;
  project_number: string;
  project_name: string;
  report_date: string | null;
  casting_date: string | null;
  paper_field_id: string | null;
  ticket_number: string | null;
  supplier_name: string | null;
  mix_number: string | null;
  technician_user_id: string | null;
  workflow_state: string;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The Concrete Lab workspace reads (MM-V2-C31): the receiving queue (Awaiting pickup / Awaiting
 * receiving, My reports first) and Concrete search. Both read like every concrete read before
 * them (`inventory.read`, every project, LAB included); lists never grant anything and say
 * nothing about who may act. The dashboard's other counts come from C22's worklist and C28's
 * review queue, so each count is its list's own total (AC3).
 */
@Injectable()
export class ConcreteLabService {
  constructor(private readonly database: DatabaseService) {}

  async receivingQueue(rawQuery: unknown, user: AuthUser): Promise<ConcreteReceivingQueue> {
    const query = parseBody(concreteReceivingQueueQuerySchema, rawQuery);
    const db = this.database.pool;
    const projectId = query.projectId ?? null;

    const { rows: countRows } = await db.query<{
      stage: ConcreteReceivingStage;
      n: number;
      mine: number;
    }>(
      `SELECT ss.stage, count(*)::int AS n,
              count(*) FILTER (WHERE r.technician_user_id = $2)::int AS mine
       FROM (${SET_STAGE}) ss
       JOIN concrete_specimen_set st ON st.id = ss.set_id
       JOIN concrete_field_report r ON r.id = st.field_report_id
       GROUP BY ss.stage`,
      [projectId, user.userId],
    );
    const counts = Object.fromEntries(CONCRETE_RECEIVING_STAGES.map((s) => [s, 0])) as Record<
      ConcreteReceivingStage,
      number
    >;
    let mineTotal = 0;
    for (const row of countRows) {
      counts[row.stage] = row.n;
      if (row.stage === query.stage) mineTotal = row.mine;
    }

    const offset = (query.page - 1) * query.pageSize;
    const { rows } = await db.query<QueueRowSql>(
      `SELECT ss.set_id, st.field_report_id, st.project_id, p.project_number,
              p.name AS project_name, st.temporary_id, st.permanent_id, r.cast_at,
              r.technician_user_id, coalesce(r.technician_user_id = $2, false) AS mine,
              ss.letters, r.workflow_state,
              (SELECT count(*)::int FROM concrete_specimen x WHERE x.set_id = ss.set_id)
                AS specimen_count
       FROM (${SET_STAGE}) ss
       JOIN concrete_specimen_set st ON st.id = ss.set_id
       JOIN concrete_field_report r ON r.id = st.field_report_id
       JOIN project p ON p.id = st.project_id
       WHERE ss.stage = $3
       ORDER BY coalesce(r.technician_user_id = $2, false) DESC, r.cast_at, p.project_number,
                st.permanent_number NULLS LAST, st.temporary_id NULLS LAST, st.id
       LIMIT ${query.pageSize} OFFSET ${offset}`,
      [projectId, user.userId, query.stage],
    );
    const people = await peopleOf(
      db,
      rows.map((r) => r.technician_user_id),
    );
    const items: ConcreteReceivingQueueRow[] = rows.map((row) => ({
      setId: row.set_id,
      fieldReportId: row.field_report_id,
      projectId: row.project_id,
      projectNumber: row.project_number,
      projectName: row.project_name,
      identity: { temporaryId: row.temporary_id, permanentId: row.permanent_id },
      castAt: row.cast_at.toISOString(),
      technician: row.technician_user_id ? (people.get(row.technician_user_id) ?? null) : null,
      mine: row.mine,
      letters: row.letters,
      specimenCount: row.specimen_count,
      reportState: row.workflow_state,
    }));
    return {
      stage: query.stage,
      counts,
      mineTotal,
      total: counts[query.stage],
      page: query.page,
      pageSize: query.pageSize,
      items,
    };
  }

  async search(rawQuery: unknown): Promise<ConcreteSearch> {
    const query = parseBody(concreteSearchQuerySchema, rawQuery);
    const terms = concreteSearchTerms(query.q);
    const db = this.database.pool;
    const rankOf = (match: ConcreteSearchMatch) => CONCRETE_SEARCH_MATCHES.indexOf(match);
    const branches: { sql: string; params: unknown[] }[] = [];
    const prefix = `${escapeLike(terms.text)}%`;
    const lowerPrefix = `${escapeLike(terms.lower)}%`;
    const long = terms.text.length >= CONCRETE_SEARCH_MIN_LENGTH;

    // Set aliases: exact (the set part of a specimen ID too), then from the start. Every other
    // reference is searched too: a ticket or Field ID may look like a set number.
    const alias = terms.setAlias ?? terms.text;
    branches.push({
      sql: `SELECT field_report_id AS report_id, 'set_id' AS match, id AS set_id
            FROM concrete_specimen_set WHERE permanent_id = $1 OR temporary_id = $1`,
      params: [alias],
    });
    if (long) {
      branches.push({
        sql: `SELECT field_report_id AS report_id, 'set_id_prefix' AS match, id AS set_id
              FROM concrete_specimen_set
              WHERE (permanent_id LIKE $1 OR temporary_id LIKE $1)
                AND permanent_id IS DISTINCT FROM $2 AND temporary_id IS DISTINCT FROM $2`,
        params: [prefix, terms.text],
      });
    }
    branches.push({
      sql: `SELECT id AS report_id, 'ticket' AS match, NULL::uuid AS set_id
            FROM concrete_field_report
            WHERE ticket_number IS NOT NULL AND lower(btrim(ticket_number)) LIKE $1`,
      params: [long ? lowerPrefix : escapeLike(terms.lower)],
    });
    branches.push({
      sql: `SELECT r.id AS report_id, 'project' AS match, NULL::uuid AS set_id
            FROM project p JOIN concrete_field_report r ON r.project_id = p.id
            WHERE p.project_number_normalized LIKE $1`,
      params: [long ? lowerPrefix : escapeLike(terms.lower)],
    });
    branches.push({
      sql: `SELECT id AS report_id, 'field_id' AS match, NULL::uuid AS set_id
            FROM concrete_field_report
            WHERE paper_field_id IS NOT NULL AND lower(btrim(paper_field_id)) LIKE $1`,
      params: [long ? lowerPrefix : escapeLike(terms.lower)],
    });
    branches.push({
      sql: `SELECT id AS report_id, 'mix' AS match, NULL::uuid AS set_id
            FROM concrete_field_report
            WHERE mix_number IS NOT NULL AND lower(btrim(mix_number)) LIKE $1`,
      params: [long ? lowerPrefix : escapeLike(terms.lower)],
    });
    if (long) {
      branches.push({
        sql: `SELECT r.id AS report_id, 'technician' AS match, NULL::uuid AS set_id
              FROM app_user u JOIN concrete_field_report r ON r.technician_user_id = u.id
              WHERE lower(u.display_name) LIKE $1 OR lower(u.official_initials) = $2`,
        params: [`%${escapeLike(terms.lower)}%`, terms.lower],
      });
    }
    if (terms.date) {
      // The casting date is the America/Edmonton day of cast_at (concrete_casting_date).
      branches.push({
        sql: `SELECT id AS report_id, 'casting_date' AS match, NULL::uuid AS set_id
              FROM concrete_field_report
              WHERE cast_at >= ($1::date)::timestamp AT TIME ZONE 'America/Edmonton'
                AND cast_at < ($1::date + 1)::timestamp AT TIME ZONE 'America/Edmonton'`,
        params: [terms.date],
      });
    }

    // Each branch is bounded, then the candidates are ranked per report: the best match first,
    // then the latest casting.
    const params: unknown[] = [];
    const union = branches
      .map((branch) => {
        const sql = branch.sql.replace(
          /\$(\d+)/g,
          (_, n: string) => `$${Number(n) + params.length}`,
        );
        params.push(...branch.params);
        return `(${sql} LIMIT ${BRANCH_LIMIT})`;
      })
      .join(' UNION ALL ');
    const rankCase = `CASE c.match ${CONCRETE_SEARCH_MATCHES.map(
      (m) => `WHEN '${m}' THEN ${rankOf(m)}`,
    ).join(' ')} END`;
    const { rows: candidates } = await db.query<SearchCandidate & { cast_at: Date | null }>(
      `SELECT c.report_id, min(${rankCase})::int AS rank,
              array_agg(DISTINCT c.match) AS matches,
              array_agg(DISTINCT c.set_id) FILTER (WHERE c.set_id IS NOT NULL) AS set_ids,
              r.cast_at
       FROM (${union}) c JOIN concrete_field_report r ON r.id = c.report_id
       GROUP BY c.report_id, r.cast_at`,
      params,
    );
    candidates.sort(
      (a, b) =>
        a.rank - b.rank ||
        (b.cast_at?.getTime() ?? -Infinity) - (a.cast_at?.getTime() ?? -Infinity) ||
        a.report_id.localeCompare(b.report_id),
    );
    const total = candidates.length;
    const offset = (query.page - 1) * query.pageSize;
    const page = candidates.slice(offset, offset + query.pageSize);

    const ids = page.map((c) => c.report_id);
    const { rows: reports } = await db.query<SearchReportSql>(
      `SELECT r.id, r.project_id, p.project_number, p.name AS project_name,
              r.report_date::text AS report_date,
              concrete_casting_date(r.cast_at)::text AS casting_date, r.paper_field_id,
              r.ticket_number, r.supplier_name, r.mix_number, r.technician_user_id,
              r.workflow_state
       FROM concrete_field_report r JOIN project p ON p.id = r.project_id
       WHERE r.id = ANY($1::uuid[])`,
      [ids],
    );
    const { rows: sets } = await db.query<{
      id: string;
      field_report_id: string;
      temporary_id: string | null;
      permanent_id: string | null;
      voided: boolean;
      specimen_count: number;
    }>(
      `SELECT st.id, st.field_report_id, st.temporary_id, st.permanent_id,
              st.voided_at IS NOT NULL AS voided,
              (SELECT count(*)::int FROM concrete_specimen x WHERE x.set_id = st.id)
                AS specimen_count
       FROM concrete_specimen_set st WHERE st.field_report_id = ANY($1::uuid[])
       ORDER BY st.permanent_number NULLS LAST, st.temporary_id NULLS LAST, st.created_at, st.id`,
      [ids],
    );
    const { rows: projectCount } = await db.query<{ n: number }>(
      `SELECT count(DISTINCT project_id)::int AS n FROM concrete_field_report
       WHERE id = ANY($1::uuid[])`,
      [candidates.map((c) => c.report_id)],
    );
    const people = await peopleOf(
      db,
      reports.map((r) => r.technician_user_id),
    );
    const byId = new Map(reports.map((r) => [r.id, r]));
    const items: ConcreteSearchResult[] = page.map((candidate) => {
      const report = byId.get(candidate.report_id)!;
      const matchedSets = new Set(candidate.set_ids ?? []);
      return {
        fieldReportId: report.id,
        projectId: report.project_id,
        projectNumber: report.project_number,
        projectName: report.project_name,
        reportDate: report.report_date,
        castingDate: report.casting_date,
        paperFieldId: report.paper_field_id,
        ticketNumber: report.ticket_number,
        supplierName: report.supplier_name,
        mixNumber: report.mix_number,
        technician: report.technician_user_id
          ? (people.get(report.technician_user_id) ?? null)
          : null,
        workflowState: report.workflow_state,
        matches: [...candidate.matches].sort((a, b) => rankOf(a) - rankOf(b)),
        sets: sets
          .filter((s) => s.field_report_id === report.id)
          .map((s) => ({
            setId: s.id,
            identity: { temporaryId: s.temporary_id, permanentId: s.permanent_id },
            specimenCount: s.specimen_count,
            voided: s.voided,
            matched: matchedSets.has(s.id),
          })),
      };
    });
    return {
      q: query.q,
      letter: terms.letter,
      total,
      page: query.page,
      pageSize: query.pageSize,
      projectCount: projectCount[0]?.n ?? 0,
      items,
    };
  }
}
