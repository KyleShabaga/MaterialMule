import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CONCRETE_HOLD_AGE,
  concreteLabToday,
  concreteProjectSpecimenQuerySchema,
  type ConcreteProjectSpecimenList,
  type ConcreteProjectSpecimenStatus,
} from '@materialmule/shared';
import { DatabaseService } from '../database/database.service.js';
import { findProject } from '../project-access/project-access.service.js';
import { likeEscape } from '../projects/projects.service.js';
import { parseBody } from '../validation/parse-body.js';

/** The status rule of the shared `concreteProjectSpecimenStatus`, in SQL ($2 = today). */
const STATUS_SQL = `CASE
    WHEN st.voided_at IS NOT NULL OR r.workflow_state = 'void' THEN 'void'
    WHEN sp.assigned_age = 'HOLD' AND sp.hold_expires_on IS NOT NULL THEN 'hold'
    WHEN sp.assigned_age = 'HOLD' OR sp.target_date IS NULL THEN 'awaiting_casting'
    WHEN sp.target_date = $2::date THEN 'due_today'
    WHEN sp.target_date < $2::date THEN 'overdue'
    ELSE 'scheduled'
  END`;

interface Row {
  specimen_id: string;
  letter: string;
  set_id: string;
  permanent_id: string | null;
  temporary_id: string | null;
  field_report_id: string;
  workflow_state: string;
  casting_date: string | null;
  location_elements: string[];
  location_element_other: string | null;
  location_description: string | null;
  assigned_age: string | null;
  target_date: string | null;
  hold_expires_on: string | null;
  status: ConcreteProjectSpecimenStatus;
}

/**
 * The project Concrete section's Specimens tab (MM-V2-C30): read only, `inventory.read` like the
 * project's field reports and mixes. Dates are the stored C05 target / HOLD-expiry dates; the
 * status is derived on today's date (America/Edmonton) and never stored.
 */
@Injectable()
export class ConcreteProjectSpecimensService {
  constructor(private readonly database: DatabaseService) {}

  async list(projectId: string, rawQuery: unknown): Promise<ConcreteProjectSpecimenList> {
    const project = await findProject(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    const query = parseBody(concreteProjectSpecimenQuerySchema, rawQuery);
    const today = concreteLabToday();
    const params: unknown[] = [project.id, today];
    const where: string[] = [];
    if (query.status) {
      params.push(query.status);
      where.push(`x.status = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${likeEscape(query.search)}%`);
      const p = `$${params.length}`;
      where.push(`((x.permanent_id || x.letter) ILIKE ${p} OR (x.temporary_id || x.letter) ILIKE ${p}
        OR x.location_description ILIKE ${p} OR x.location_element_other ILIKE ${p}
        OR EXISTS (SELECT 1 FROM unnest(x.location_elements) e WHERE e ILIKE ${p}))`);
    }
    const base = `SELECT sp.id AS specimen_id, sp.letter, st.id AS set_id, st.permanent_id,
         st.temporary_id, r.id AS field_report_id, r.workflow_state,
         concrete_casting_date(r.cast_at)::text AS casting_date, r.location_elements,
         r.location_element_other, r.location_description, sp.assigned_age,
         sp.target_date::text, sp.hold_expires_on::text, ${STATUS_SQL} AS status,
         r.cast_at, r.created_at AS report_created_at
       FROM concrete_specimen sp
       JOIN concrete_specimen_set st ON st.id = sp.set_id
       JOIN concrete_field_report r ON r.id = st.field_report_id
       WHERE sp.project_id = $1`;
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows: total } = await this.database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (${base}) x ${whereSql}`,
      params,
    );
    const { rows } = await this.database.pool.query<Row>(
      `SELECT x.* FROM (${base}) x ${whereSql}
       ORDER BY x.cast_at DESC NULLS FIRST, x.report_created_at DESC, x.set_id, x.letter
       LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      params,
    );
    return {
      projectId: project.id,
      today,
      items: rows.map((row) => ({
        specimenId: row.specimen_id,
        label: row.permanent_id
          ? `${row.permanent_id}${row.letter}`
          : row.temporary_id
            ? `${row.temporary_id}${row.letter}`
            : `Unnumbered ${row.letter}`,
        setId: row.set_id,
        fieldReportId: row.field_report_id,
        reportState: row.workflow_state,
        castingDate: row.casting_date,
        structure: [
          ...row.location_elements,
          ...(row.location_element_other ? [row.location_element_other] : []),
        ],
        location: row.location_description,
        assignedAge:
          row.assigned_age === null
            ? null
            : row.assigned_age === CONCRETE_HOLD_AGE
              ? CONCRETE_HOLD_AGE
              : Number(row.assigned_age),
        testDate: row.assigned_age === CONCRETE_HOLD_AGE ? row.hold_expires_on : row.target_date,
        // C07/C23 fill this from the specimen's test result.
        strengthMpa: null,
        status: row.status,
      })),
      total: total[0]!.n,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}
