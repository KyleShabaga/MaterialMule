import type { ConcreteReportFile, ConcreteNumberedReportKind } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

// MM-V2-C32: where issued report files live. Attachment storage (C15) isn't built, so the bytes
// are kept in PostgreSQL (`concrete_report_file.content`, bytea) behind this interface; C15 can
// provide another implementation that keeps the same record (hash, template, number, revision)
// and moves only the bytes. Files are written once, at issue, and never changed or regenerated.

type Db = Pool | PoolClient;

export interface NewReportFile {
  kind: ConcreteNumberedReportKind;
  projectId: string;
  reportNumberId: string;
  templateId: string;
  /** The issued version (field; strength with C39) or the summary report it renders. */
  reportVersionId: string | null;
  summaryReportId: string | null;
  fileName: string;
  content: Uint8Array;
  includePhotos: boolean;
  includeMachineInfo: boolean;
  createdByUserId: string;
}

export interface StoredReportFile {
  record: ConcreteReportFile;
  projectId: string;
  content: Buffer;
}

export interface ReportFileStore {
  /** Writes the file in the caller's transaction; returns its record (hash set by the database). */
  save(client: PoolClient, file: NewReportFile): Promise<ConcreteReportFile>;
  /** The record of each file, by id. */
  records(db: Db, ids: string[]): Promise<Map<string, ConcreteReportFile>>;
  /** The record and bytes, or null. */
  read(db: Db, id: string): Promise<StoredReportFile | null>;
}

interface FileRow {
  id: string;
  report_kind: ConcreteNumberedReportKind;
  project_id: string;
  report_number: string;
  revision_no: number;
  supersedes_file_id: string | null;
  file_name: string;
  byte_size: number;
  sha256: string;
  include_photos: boolean;
  include_machine_info: boolean;
  created_at: Date;
  template_id: string;
  template_revision: string;
  template_name: string;
  template_provisional: boolean;
}

const RECORD_COLUMNS = `f.id, f.report_kind, f.project_id, n.report_number, f.revision_no,
  f.supersedes_file_id, f.file_name, f.byte_size, f.sha256, f.include_photos,
  f.include_machine_info, f.created_at, t.id AS template_id, t.revision AS template_revision,
  t.name AS template_name, t.provisional AS template_provisional`;
const RECORD_FROM = `concrete_report_file f
  JOIN concrete_report_number n ON n.id = f.report_number_id
  JOIN concrete_report_template t ON t.id = f.report_template_id`;

function recordOf(row: FileRow): ConcreteReportFile {
  return {
    id: row.id,
    kind: row.report_kind,
    reportNumber: row.report_number,
    revisionNo: row.revision_no,
    supersedesFileId: row.supersedes_file_id,
    fileName: row.file_name,
    mediaType: 'application/pdf',
    byteSize: row.byte_size,
    sha256: row.sha256,
    template: {
      id: row.template_id,
      kind: row.report_kind,
      revision: row.template_revision,
      name: row.template_name,
      provisional: row.template_provisional,
    },
    includePhotos: row.include_photos,
    includeMachineInfo: row.include_machine_info,
    createdAt: row.created_at.toISOString(),
  };
}

/** The PostgreSQL implementation (until C15). */
export class DatabaseReportFileStore implements ReportFileStore {
  async save(client: PoolClient, file: NewReportFile): Promise<ConcreteReportFile> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO concrete_report_file
         (report_kind, project_id, report_number_id, report_template_id, revision_no,
          report_version_id, summary_report_id, file_name, content, byte_size, sha256,
          include_photos, include_machine_info, created_by_user_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, 0, '', $9, $10, $11) RETURNING id`,
      [
        file.kind,
        file.projectId,
        file.reportNumberId,
        file.templateId,
        file.reportVersionId,
        file.summaryReportId,
        file.fileName,
        Buffer.from(file.content),
        file.includePhotos,
        file.includeMachineInfo,
        file.createdByUserId,
      ],
    );
    return (await this.records(client, [rows[0]!.id])).get(rows[0]!.id)!;
  }

  async records(db: Db, ids: string[]): Promise<Map<string, ConcreteReportFile>> {
    if (ids.length === 0) return new Map();
    const { rows } = await db.query<FileRow>(
      `SELECT ${RECORD_COLUMNS} FROM ${RECORD_FROM} WHERE f.id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((row) => [row.id, recordOf(row)]));
  }

  async read(db: Db, id: string): Promise<StoredReportFile | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await db.query<FileRow & { content: Buffer }>(
      `SELECT ${RECORD_COLUMNS}, f.content FROM ${RECORD_FROM} WHERE f.id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? { record: recordOf(row), projectId: row.project_id, content: row.content } : null;
  }
}

/** The store in use (C15 swaps the implementation here). */
export const reportFileStore: ReportFileStore = new DatabaseReportFileStore();
