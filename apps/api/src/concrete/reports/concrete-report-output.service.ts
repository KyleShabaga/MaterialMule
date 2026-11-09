import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CONCRETE_EXCEPTION_LABEL,
  CONCRETE_REPORT_HEADER_DEFAULT_NAME,
  concreteSummaryPreviewQuerySchema,
  issueConcreteSummaryReportRequestSchema,
  updateConcreteReportHeaderRequestSchema,
  type ConcreteFieldReportFields,
  type ConcreteReportFile,
  type ConcreteReportHeader,
  type ConcreteNumberedReportKind,
  type ConcreteStrengthReportSnapshot,
  type ConcreteSummaryAgeCell,
  type ConcreteSummaryFilters,
  type ConcreteSummaryReport,
  type ConcreteSummaryReportList,
  type ConcreteSummaryRow,
  type ConcreteSummarySnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../../audit/audit.js';
import { can, type AuthUser } from '../../auth/policy.js';
import { canUnderLock } from '../../auth/standing.js';
import { DatabaseService } from '../../database/database.service.js';
import { withTransaction } from '../../db/transaction.js';
import { projectContext } from '../../project-access/project-access.service.js';
import { parseBody } from '../../validation/parse-body.js';
import { testingMachineSnapshot } from '../concrete-equipment.service.js';
import { FIELD_REPORT_SCOPE } from '../concrete-report-lifecycle.read.js';
import {
  renderFieldReportPdf,
  setLabel,
  type FieldReportSnapshot,
} from './field-report-template.js';
import { formatDate, type ReportHeaderText } from './pdf-layout.js';
import { allocateReportNumber, type AllocatedReportNumber } from './report-numbers.js';
import { reportFileStore, type StoredReportFile } from './report-file-store.js';
import { renderStrengthReportPdf } from './strength-report-template.js';
import { renderSummaryReportPdf } from './summary-report-template.js';

// MM-V2-C32: rendering and storing issued concrete reports (provisional designs P1, G2).
// - Field reports: at every issue (first issue and each issued revision), inside C09's issue
//   transaction, from the version's frozen snapshot plus what is copied at issue (header, lead,
//   reviewer and issuer, exception notes, the testing machine when included). The bytes are
//   stored once with their SHA-256 and never regenerated (AC1/AC2).
// - Project summary: previewed (unnumbered, never stored) and issued (CSR number, stored) from
//   the same snapshot builder and renderer, so the preview is what issuing stores.
// - Strength reports (MM-V2-C39): the same at every issue of a strength report (first issue and
//   each cumulative or corrective revision), from C39's frozen `ConcreteStrengthReportSnapshot`,
//   with the CS number from the allocator (subject = the strength report).

type Db = Pool | PoolClient;

export interface ReportTemplateRow {
  id: string;
  kind: ConcreteNumberedReportKind;
  revision: string;
  name: string;
  provisional: boolean;
}

/** Template revisions this build can render, per kind. A new revision adds its renderer here. */
const RENDERABLE: Record<ConcreteNumberedReportKind, ReadonlySet<string>> = {
  field: new Set(['P1']),
  strength: new Set(['P1']),
  summary: new Set(['P1']),
};

export interface PreparedFieldIssue {
  number: AllocatedReportNumber;
  template: ReportTemplateRow;
}

/** The template and number an issue records on its version (field or strength). */
export type PreparedReportIssue = PreparedFieldIssue;

function unprocessable(code: string, field: string, message: string): never {
  throw new UnprocessableEntityException({ code, errors: [{ field, message }] });
}

/** The template revision in force now for `kind`, or a refusal naming the gap. */
export async function templateInForce(
  db: Db,
  kind: ConcreteNumberedReportKind,
): Promise<ReportTemplateRow> {
  const { rows } = await db.query<ReportTemplateRow>(
    `SELECT id, report_kind AS kind, revision, name, provisional FROM concrete_report_template
     WHERE report_kind = $1 AND in_force_from <= now()
     ORDER BY in_force_from DESC, revision DESC LIMIT 1`,
    [kind],
  );
  const template = rows[0];
  if (!template) {
    unprocessable(
      'report_template_missing',
      'template',
      'No report template is in force for this report',
    );
  }
  if (!RENDERABLE[kind].has(template.revision)) {
    unprocessable(
      'report_template_unsupported',
      'template',
      'The report template in force can’t be rendered by this version of Material Mule',
    );
  }
  return template;
}

export async function reportHeaderOf(db: Db): Promise<ConcreteReportHeader> {
  const { rows } = await db.query<{
    company_name: string;
    address: string | null;
    phone: string | null;
    version: number;
    updated_at: Date;
  }>(
    'SELECT company_name, address, phone, version, updated_at FROM concrete_report_header_setting',
  );
  const row = rows[0];
  return row
    ? {
        companyName: row.company_name,
        address: row.address,
        phone: row.phone,
        version: row.version,
        updatedAt: row.updated_at.toISOString(),
      }
    : {
        companyName: CONCRETE_REPORT_HEADER_DEFAULT_NAME,
        address: null,
        phone: null,
        version: 1,
        updatedAt: new Date(0).toISOString(),
      };
}

function headerText(header: ConcreteReportHeader): ReportHeaderText {
  return { companyName: header.companyName, address: header.address, phone: header.phone };
}

async function displayNames(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM app_user WHERE id = ANY($1::uuid[])',
    [unique],
  );
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

async function projectHeader(db: Db, projectId: string) {
  const { rows } = await db.query<{
    id: string;
    project_number: string;
    name: string;
    client: string | null;
    lead_project_engineer_user_id: string | null;
    lead_name: string | null;
  }>(
    `SELECT p.id, p.project_number, p.name, p.client, p.lead_project_engineer_user_id,
            u.display_name AS lead_name
     FROM project p LEFT JOIN app_user u ON u.id = p.lead_project_engineer_user_id
     WHERE p.id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ConcreteReportOutputService {
  constructor(private readonly database: DatabaseService) {}

  // ---- Field reports (called by the C09 issue command) --------------------------------------------

  /**
   * Before the version is issued: the template in force and the report's number (allocated now
   * at first issue; a revision keeps it). Runs inside the issue transaction.
   */
  async prepareFieldIssue(
    client: PoolClient,
    report: { id: string; project_id: string },
    user: AuthUser,
  ): Promise<PreparedFieldIssue> {
    const template = await templateInForce(client, 'field');
    const number = await allocateReportNumber(client, {
      kind: 'field',
      projectId: report.project_id,
      subjectId: report.id,
      userId: user.userId,
    });
    return { number, template };
  }

  /** After the version is issued (same transaction): render the PDF and store it. */
  async storeFieldIssue(
    client: PoolClient,
    prepared: PreparedFieldIssue,
    report: { id: string; project_id: string },
    versionId: string,
    user: AuthUser,
  ): Promise<ConcreteReportFile> {
    const { rows } = await client.query<{
      snapshot: FieldReportSnapshot;
      issued_at: Date;
      issued_by_user_id: string;
      reviewed_by_user_id: string | null;
      reviewed_at: Date | null;
      issue_include_photos: boolean;
      issue_include_machine_info: boolean;
    }>(
      `SELECT snapshot, issued_at, issued_by_user_id, reviewed_by_user_id, reviewed_at,
              issue_include_photos, issue_include_machine_info
       FROM concrete_report_version WHERE id = $1`,
      [versionId],
    );
    const version = rows[0]!;
    const project = await projectHeader(client, report.project_id);
    const { rows: notes } = await client.query<{
      code: string;
      note: string;
      documented_by_user_id: string;
      documented_at: Date;
    }>(
      `SELECT code, note, documented_by_user_id, documented_at FROM concrete_report_exception_note
       WHERE version_id = $1 ORDER BY documented_at, id`,
      [versionId],
    );
    const names = await displayNames(client, [
      version.issued_by_user_id,
      version.reviewed_by_user_id,
      ...notes.map((n) => n.documented_by_user_id),
    ]);
    const previous = await this.previousFile(client, prepared.number.id);
    let supersedes = null;
    if (previous) {
      const { rows: revise } = await client.query<{ comment: string | null }>(
        `SELECT comment FROM concrete_report_transition
         WHERE field_report_id = $1 AND action = 'revise' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [report.id],
      );
      supersedes = {
        revisionNo: previous.revision_no,
        issuedAt: previous.created_at,
        reason: revise[0]?.comment ?? null,
      };
    }
    const revisionNo = previous ? previous.revision_no + 1 : 0;
    const machine = version.issue_include_machine_info
      ? await testingMachineSnapshot(client, formatDate(version.issued_at))
      : null;
    const header = await reportHeaderOf(client);
    const content = await renderFieldReportPdf({
      header: headerText(header),
      template: prepared.template,
      reportNumber: prepared.number.reportNumber,
      revisionNo,
      issuedAt: version.issued_at,
      supersedes,
      snapshot: version.snapshot,
      leadProjectEngineer: project?.lead_name ?? null,
      reviewedBy:
        version.reviewed_by_user_id && version.reviewed_at
          ? { name: names.get(version.reviewed_by_user_id) ?? 'Unknown', at: version.reviewed_at }
          : null,
      issuedBy: { name: names.get(version.issued_by_user_id) ?? 'Unknown', at: version.issued_at },
      exceptionNotes: notes.map((n) => ({
        label: (CONCRETE_EXCEPTION_LABEL as Record<string, string>)[n.code] ?? n.code,
        note: n.note,
        by: names.get(n.documented_by_user_id) ?? 'Unknown',
        at: n.documented_at,
      })),
      includePhotos: version.issue_include_photos,
      includeMachineInfo: version.issue_include_machine_info,
      machine,
    });
    const file = await reportFileStore.save(client, {
      kind: 'field',
      projectId: report.project_id,
      reportNumberId: prepared.number.id,
      templateId: prepared.template.id,
      reportVersionId: versionId,
      summaryReportId: null,
      fileName: `${prepared.number.reportNumber}-rev${revisionNo}.pdf`,
      content,
      includePhotos: version.issue_include_photos,
      includeMachineInfo: version.issue_include_machine_info,
      createdByUserId: user.userId,
    });
    if (file.revisionNo !== revisionNo) {
      // The database numbers revisions; a mismatch means the printed "Rev" is wrong.
      throw new Error('Report file revision does not match the rendered revision');
    }
    return file;
  }

  // ---- Strength reports (called by the C39 issue command) -----------------------------------------

  /** Before the version is issued: the strength template in force and the CS number. */
  async prepareStrengthIssue(
    client: PoolClient,
    report: { id: string; project_id: string },
    user: AuthUser,
  ): Promise<PreparedReportIssue> {
    const template = await templateInForce(client, 'strength');
    const number = await allocateReportNumber(client, {
      kind: 'strength',
      projectId: report.project_id,
      subjectId: report.id,
      userId: user.userId,
    });
    return { number, template };
  }

  /** After the version is issued (same transaction): render the strength PDF and store it. */
  async storeStrengthIssue(
    client: PoolClient,
    prepared: PreparedReportIssue,
    report: { id: string; project_id: string },
    versionId: string,
    user: AuthUser,
  ): Promise<ConcreteReportFile> {
    const { rows } = await client.query<{
      snapshot: ConcreteStrengthReportSnapshot;
      issued_at: Date;
      issued_by_user_id: string;
      reviewed_by_user_id: string | null;
      reviewed_at: Date | null;
      issue_include_photos: boolean;
      issue_include_machine_info: boolean;
    }>(
      `SELECT snapshot, issued_at, issued_by_user_id, reviewed_by_user_id, reviewed_at,
              issue_include_photos, issue_include_machine_info
       FROM concrete_report_version WHERE id = $1 AND report_kind = 'strength'`,
      [versionId],
    );
    const version = rows[0]!;
    const project = await projectHeader(client, report.project_id);
    const names = await displayNames(client, [
      version.issued_by_user_id,
      version.reviewed_by_user_id,
    ]);
    const previous = await this.previousFile(client, prepared.number.id);
    const revisionNo = previous ? previous.revision_no + 1 : 0;
    const machine = version.issue_include_machine_info
      ? await testingMachineSnapshot(client, formatDate(version.issued_at))
      : null;
    const header = await reportHeaderOf(client);
    const content = await renderStrengthReportPdf({
      header: headerText(header),
      template: prepared.template,
      reportNumber: prepared.number.reportNumber,
      revisionNo,
      issuedAt: version.issued_at,
      supersedes: previous
        ? {
            revisionNo: previous.revision_no,
            issuedAt: previous.created_at,
            reason: version.snapshot.revision?.reason ?? null,
          }
        : null,
      snapshot: version.snapshot,
      leadProjectEngineer: project?.lead_name ?? null,
      reviewedBy:
        version.reviewed_by_user_id && version.reviewed_at
          ? { name: names.get(version.reviewed_by_user_id) ?? 'Unknown', at: version.reviewed_at }
          : null,
      issuedBy: { name: names.get(version.issued_by_user_id) ?? 'Unknown', at: version.issued_at },
      includePhotos: version.issue_include_photos,
      includeMachineInfo: version.issue_include_machine_info,
      machine,
    });
    const file = await reportFileStore.save(client, {
      kind: 'strength',
      projectId: report.project_id,
      reportNumberId: prepared.number.id,
      templateId: prepared.template.id,
      reportVersionId: versionId,
      summaryReportId: null,
      fileName: `${prepared.number.reportNumber}-rev${revisionNo}.pdf`,
      content,
      includePhotos: version.issue_include_photos,
      includeMachineInfo: version.issue_include_machine_info,
      createdByUserId: user.userId,
    });
    if (file.revisionNo !== revisionNo) {
      throw new Error('Report file revision does not match the rendered revision');
    }
    return file;
  }

  private async previousFile(db: Db, numberId: string) {
    const { rows } = await db.query<{ id: string; revision_no: number; created_at: Date }>(
      `SELECT id, revision_no, created_at FROM concrete_report_file
       WHERE report_number_id = $1 ORDER BY revision_no DESC LIMIT 1`,
      [numberId],
    );
    return rows[0] ?? null;
  }

  // ---- Downloads ------------------------------------------------------------------------------

  /** An issued file (the stored bytes, never re-rendered). */
  async file(id: string): Promise<StoredReportFile> {
    const stored = UUID.test(id) ? await reportFileStore.read(this.database.pool, id) : null;
    if (!stored) throw new NotFoundException({ code: 'concrete_report_file_not_found' });
    return stored;
  }

  // ---- Report-header setting --------------------------------------------------------------------

  header(): Promise<ConcreteReportHeader> {
    return reportHeaderOf(this.database.pool);
  }

  async updateHeader(
    body: unknown,
    actor: AuditActor,
    user: AuthUser,
    requestId: string | null,
  ): Promise<ConcreteReportHeader> {
    const input = parseBody(updateConcreteReportHeaderRequestSchema, body);
    return withTransaction(this.database.pool, async (client) => {
      const { rows } = await client.query<{
        company_name: string;
        address: string | null;
        phone: string | null;
        version: number;
      }>(
        `SELECT company_name, address, phone, version FROM concrete_report_header_setting
         FOR UPDATE`,
      );
      const current = rows[0]!;
      if (current.version !== input.version) {
        throw new ConflictException({
          code: 'version_conflict',
          current: await reportHeaderOf(client),
        });
      }
      await client.query(
        `UPDATE concrete_report_header_setting
         SET company_name = $1, address = $2, phone = $3, version = version + 1,
             updated_at = now(), updated_by_user_id = $4`,
        [input.companyName, input.address, input.phone, user.userId],
      );
      await recordAudit(client, {
        action: 'concrete_report_header.changed',
        entityType: 'concrete_report_header_setting',
        entityId: null,
        actor,
        before: {
          companyName: current.company_name,
          address: current.address,
          phone: current.phone,
          version: current.version,
        },
        after: {
          companyName: input.companyName,
          address: input.address,
          phone: input.phone,
          version: current.version + 1,
        },
        requestId,
      });
      return reportHeaderOf(client);
    });
  }

  // ---- Project summary report (design section 5) -------------------------------------------------

  async summarySnapshot(
    db: Db,
    projectId: string,
    filters: ConcreteSummaryFilters,
  ): Promise<ConcreteSummarySnapshot> {
    const project = await projectHeader(db, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    let mixNumber: string | null = null;
    if (filters.mixId) {
      const { rows } = await db.query<{ mix_number: string }>(
        'SELECT mix_number FROM concrete_mix WHERE id = $1 AND project_id = $2',
        [filters.mixId, projectId],
      );
      if (!rows[0]) unprocessable('invalid_mix', 'filters.mixId', 'Choose a mix on this project');
      mixNumber = rows[0].mix_number;
    }
    const { rows: sets } = await db.query<{
      id: string;
      field_report_id: string;
      temporary_id: string | null;
      permanent_id: string | null;
      cast_date: string | null;
      location_elements: string[];
      location_element_other: string | null;
      mix_number: string | null;
      report_number: string | null;
      issued_snapshot: FieldReportSnapshot | null;
    }>(
      `SELECT s.id, s.field_report_id, s.temporary_id, s.permanent_id,
              to_char((r.cast_at AT TIME ZONE 'America/Edmonton')::date, 'YYYY-MM-DD') AS cast_date,
              r.location_elements, r.location_element_other, r.mix_number,
              n.report_number,
              (SELECT v.snapshot FROM concrete_report_version v
               WHERE v.field_report_id = r.id AND v.state = 'issued'
               ORDER BY v.version_no DESC LIMIT 1) AS issued_snapshot
       FROM concrete_specimen_set s
       JOIN concrete_field_report r ON r.id = s.field_report_id
       LEFT JOIN concrete_report_number n ON n.report_kind = 'field' AND n.subject_id = r.id
       WHERE s.project_id = $1 AND s.voided_at IS NULL AND r.workflow_state <> 'void'
         AND ($2::date IS NULL OR (r.cast_at AT TIME ZONE 'America/Edmonton')::date >= $2::date)
         AND ($3::date IS NULL OR (r.cast_at AT TIME ZONE 'America/Edmonton')::date <= $3::date)
         AND ($4::text IS NULL OR lower($4) = ANY (SELECT lower(e) FROM unnest(r.location_elements) e)
              OR lower($4) = lower(r.location_element_other))
         AND ($5::uuid IS NULL OR r.mix_id = $5)
       ORDER BY r.cast_at NULLS LAST, coalesce(s.permanent_id, s.temporary_id), s.id`,
      [projectId, filters.from, filters.to, filters.element, filters.mixId],
    );
    const { rows: specimens } = await db.query<{
      set_id: string;
      assigned_age: string | null;
      tested: boolean;
    }>(
      `SELECT sp.set_id, sp.assigned_age,
              EXISTS (SELECT 1 FROM concrete_test_result t
                      WHERE t.specimen_id = sp.id AND t.tested_on IS NOT NULL
                        AND t.max_load IS NOT NULL) AS tested
       FROM concrete_specimen sp WHERE sp.set_id = ANY($1::uuid[])`,
      [sets.map((s) => s.id)],
    );
    const ages = [
      ...new Set(
        specimens
          .map((s) => s.assigned_age)
          .filter((a): a is string => a !== null && /^\d+$/.test(a))
          .map(Number),
      ),
    ].sort((a, b) => a - b);

    const rows: ConcreteSummaryRow[] = sets.map((set) => {
      const own = specimens.filter((s) => s.set_id === set.id);
      const cells: Record<string, ConcreteSummaryAgeCell> = {};
      for (const age of ages) {
        const at = own.filter((s) => s.assigned_age === String(age));
        // Only issued strength values print (C39/C24); none exist yet, so a tested specimen is
        // pending review.
        cells[String(age)] =
          at.length === 0
            ? { status: 'not_scheduled' }
            : at.some((s) => s.tested)
              ? { status: 'pending_review' }
              : { status: 'untested' };
      }
      const issued = set.issued_snapshot;
      const f: ConcreteFieldReportFields | null = issued?.fields ?? null;
      const initial = (test: 'slump' | 'air') =>
        f?.readings.find((r) => r.test === test && r.context === 'initial')?.value ?? null;
      const elements = (f?.locationElements ?? set.location_elements).filter((e) => e !== 'Other');
      const other = f ? f.locationElementOther : set.location_element_other;
      if (other) elements.push(other);
      const numeric = Object.values(cells).filter((c) => c.status !== 'not_scheduled');
      return {
        setId: set.id,
        setLabel: setLabel({
          identity: { permanentId: set.permanent_id, temporaryId: set.temporary_id },
        }),
        castDate: set.cast_date,
        fieldReportNumber: issued ? set.report_number : null,
        elements: elements.length ? elements.join(', ') : null,
        mixNumber: f ? f.mixNumber : set.mix_number,
        specifiedStrengthMpa: f?.projectSpec.specifiedStrengthMpa ?? null,
        specifiedStrengthAgeDays: f?.projectSpec.specifiedStrengthAgeDays ?? null,
        slumpMm: initial('slump'),
        airPercent: initial('air'),
        concreteTempC: f?.concreteTempC ?? null,
        ages: cells,
        holdCount: own.filter((s) => s.assigned_age === 'HOLD').length,
        status:
          numeric.length > 0 && numeric.every((c) => c.status === 'issued')
            ? 'all_issued'
            : 'pending',
      };
    });
    return {
      kind: 'summary',
      projectId: project.id,
      projectNumber: project.project_number,
      projectName: project.name,
      client: project.client,
      leadProjectEngineer: project.lead_name,
      filters: { ...filters, mixNumber },
      ages,
      rows,
      totals: {
        sets: rows.length,
        allIssued: rows.filter((r) => r.status === 'all_issued').length,
        pending: rows.filter((r) => r.status === 'pending').length,
      },
    };
  }

  /** The unnumbered preview: the same snapshot and renderer as issuing, never stored. */
  async previewSummary(projectId: string, query: unknown): Promise<Uint8Array> {
    if (!UUID.test(projectId)) throw new NotFoundException({ code: 'project_not_found' });
    const parsed = concreteSummaryPreviewQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        code: 'validation_failed',
        errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const filters = parsed.data;
    if (filters.from && filters.to && filters.from > filters.to) {
      unprocessable('validation_failed', 'to', 'The end date is before the start date');
    }
    const db = this.database.pool;
    const template = await templateInForce(db, 'summary');
    const snapshot = await this.summarySnapshot(db, projectId, filters);
    return renderSummaryReportPdf({
      header: headerText(await reportHeaderOf(db)),
      template,
      reportNumber: null,
      issuedAt: null,
      issuedBy: null,
      snapshot,
    });
  }

  async listSummaries(projectId: string, user: AuthUser): Promise<ConcreteSummaryReportList> {
    if (!UUID.test(projectId)) throw new NotFoundException({ code: 'project_not_found' });
    const db = this.database.pool;
    const project = await projectHeader(db, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    const context = await projectContext(db, project, FIELD_REPORT_SCOPE, FIELD_REPORT_SCOPE);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM concrete_summary_report WHERE project_id = $1 ORDER BY issued_at DESC, id`,
      [projectId],
    );
    return {
      projectId,
      items: await this.summaries(
        db,
        rows.map((r) => r.id),
      ),
      canIssue: can(user, 'report.issue', context),
    };
  }

  private async summaries(db: Db, ids: string[]): Promise<ConcreteSummaryReport[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query<{
      id: string;
      report_number: string;
      issued_at: Date;
      issued_by_user_id: string;
      issued_by_name: string;
      snapshot: ConcreteSummarySnapshot;
      file_id: string;
    }>(
      `SELECT s.id, n.report_number, s.issued_at, s.issued_by_user_id,
              u.display_name AS issued_by_name, s.snapshot, f.id AS file_id
       FROM concrete_summary_report s
       JOIN concrete_report_number n ON n.id = s.report_number_id
       JOIN app_user u ON u.id = s.issued_by_user_id
       JOIN concrete_report_file f ON f.summary_report_id = s.id
       WHERE s.id = ANY($1::uuid[])
       ORDER BY s.issued_at DESC, s.id`,
      [ids],
    );
    const files = await reportFileStore.records(
      db,
      rows.map((r) => r.file_id),
    );
    return rows.map((row) => ({
      id: row.id,
      reportNumber: row.report_number,
      issuedAt: row.issued_at.toISOString(),
      issuedBy: { userId: row.issued_by_user_id, name: row.issued_by_name },
      filters: row.snapshot.filters,
      totals: row.snapshot.totals,
      file: files.get(row.file_id)!,
    }));
  }

  /**
   * Issue a summary: `report.issue` on the project (the lead or an Authorized report issuer for
   * concrete_field reports), checked before the body and again under the project lock. No
   * separate review: it only restates issued results (design section 5).
   */
  async issueSummary(
    projectId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSummaryReport> {
    if (!UUID.test(projectId)) throw new NotFoundException({ code: 'project_not_found' });
    const project = await projectHeader(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    const context = await projectContext(
      this.database.pool,
      project,
      FIELD_REPORT_SCOPE,
      FIELD_REPORT_SCOPE,
    );
    if (!can(user, 'report.issue', context)) {
      throw new ForbiddenException({ code: 'forbidden' });
    }
    const input = parseBody(issueConcreteSummaryReportRequestSchema, body);
    const hash = createHash('sha256')
      .update(JSON.stringify({ projectId, filters: input.filters }))
      .digest('hex');
    const replay = async (db: Db) => {
      const { rows } = await db.query<{
        id: string;
        request_hash: string;
        issued_by_user_id: string;
      }>(
        `SELECT id, request_hash, issued_by_user_id FROM concrete_summary_report
         WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const found = rows[0];
      if (!found) return null;
      if (found.request_hash !== hash || found.issued_by_user_id !== user.userId) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      return (await this.summaries(db, [found.id]))[0]!;
    };
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const earlier = await replay(client);
        if (earlier) return earlier;
        const { leadProjectEngineerUserId: _lead, ...facts } = context;
        void _lead;
        if (!(await canUnderLock(client, user, 'report.issue', projectId, { context: facts }))) {
          throw new ForbiddenException({ code: 'forbidden' });
        }
        const template = await templateInForce(client, 'summary');
        const snapshot = await this.summarySnapshot(client, projectId, input.filters);
        const id = randomUUID();
        const number = await allocateReportNumber(client, {
          kind: 'summary',
          projectId,
          subjectId: id,
          userId: user.userId,
        });
        const { rows } = await client.query<{ issued_at: Date }>(
          `INSERT INTO concrete_summary_report
             (id, project_id, report_number_id, filters, snapshot, snapshot_sha256,
              issued_by_user_id, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8) RETURNING issued_at`,
          [
            id,
            projectId,
            number.id,
            JSON.stringify(input.filters),
            JSON.stringify(snapshot),
            user.userId,
            input.idempotencyKey,
            hash,
          ],
        );
        const issuedAt = rows[0]!.issued_at;
        const names = await displayNames(client, [user.userId]);
        const content = await renderSummaryReportPdf({
          header: headerText(await reportHeaderOf(client)),
          template,
          reportNumber: number.reportNumber,
          issuedAt,
          issuedBy: { name: names.get(user.userId) ?? 'Unknown', at: issuedAt },
          snapshot,
        });
        const file = await reportFileStore.save(client, {
          kind: 'summary',
          projectId,
          reportNumberId: number.id,
          templateId: template.id,
          reportVersionId: null,
          summaryReportId: id,
          fileName: `${number.reportNumber}.pdf`,
          content,
          includePhotos: false,
          includeMachineInfo: false,
          createdByUserId: user.userId,
        });
        await recordAudit(client, {
          action: 'concrete_summary_report.issued',
          entityType: 'concrete_summary_report',
          entityId: id,
          actor,
          after: {
            reportNumber: number.reportNumber,
            projectId,
            filters: input.filters,
            totals: snapshot.totals,
            templateId: template.id,
            templateRevision: template.revision,
            fileSha256: file.sha256,
          },
          requestId,
        });
        return (await this.summaries(client, [id]))[0]!;
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'constraint' in error &&
        (error as { constraint?: string }).constraint === 'concrete_summary_report_idempotency_key'
      ) {
        const earlier = await replay(this.database.pool);
        if (earlier) return earlier;
      }
      throw error;
    }
  }
}
