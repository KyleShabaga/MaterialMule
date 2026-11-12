import {
  LAB_PROGRAM_STATUS_STAGE,
  PROJECT_STAGE,
  storageUnitStage,
  type SidebarRecordKind,
  type StageKey,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { AuthUser } from '../auth/policy.js';

type Db = Pool | PoolClient;

export interface RecordRef {
  kind: SidebarRecordKind;
  id: string;
}

/** What a pinned or recent row shows for a record the person may open. */
export interface RecordFace {
  label: string;
  name: string;
  stage: StageKey;
  href: string;
}

export const refKey = (ref: RecordRef) => `${ref.kind}:${ref.id}`;

/**
 * Looks up each record and returns its face, keyed by `kind:id`, for those the person may open
 * now. A missing key means unavailable: deleted, never existed, or not openable by `user`.
 *
 * Access follows each detail endpoint as it stands (STRATA-11), for the personal and test
 * accounts that hold pins and recents:
 * - storage unit, project, specimen set: `inventory.read`, which every active internal user
 *   holds, so existence is the whole check;
 * - lab program: `lab_program.read` for all, but a draft is seen only by the account that
 *   created it (the programs service's `visible` rule).
 */
export async function describeRecords(
  db: Db,
  user: AuthUser,
  refs: RecordRef[],
): Promise<Map<string, RecordFace>> {
  const ids = (kind: SidebarRecordKind) => [
    ...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id)),
  ];
  const faces = new Map<string, RecordFace>();
  const units = ids('storage_unit');
  const projects = ids('project');
  const programs = ids('lab_program');
  const sets = ids('specimen_set');

  if (units.length > 0) {
    const { rows } = await db.query<{
      id: string;
      readable_id: string;
      status: string;
      project_number: string;
      project_name: string;
      location_kind: string;
      open_conflict: boolean;
      holes: string[];
    }>(
      `SELECT su.id, su.readable_id, su.status, p.project_number, p.name AS project_name,
              l.kind AS location_kind,
              EXISTS (SELECT 1 FROM location_conflict lc
                      WHERE lc.storage_unit_id = su.id AND lc.status = 'open') AS open_conflict,
              ARRAY(SELECT th.name FROM test_hole th
                    WHERE th.id IN (SELECT s.test_hole_id FROM storage_unit_hole_summary s
                                    WHERE s.storage_unit_id = su.id)
                       OR th.id = su.source_test_hole_id
                    ORDER BY th.name) AS holes
       FROM storage_unit su
       JOIN project p ON p.id = su.project_id
       JOIN location l ON l.id = su.current_location_id
       WHERE su.id = ANY($1::uuid[])`,
      [units],
    );
    for (const row of rows) {
      // Cheap facts only: retention (holds, extensions, exemptions) is not computed here, so a
      // pinned unit never shows Retention due; its own page does.
      const { stage } = storageUnitStage({
        disposed: row.status === 'disposed',
        openConflict: row.open_conflict,
        inLab: row.location_kind === 'lab',
        awaitingPutAway: row.location_kind === 'receiving_lab',
        storageTerm: null,
        retentionDue: false,
        retentionOverdue: false,
      });
      faces.set(refKey({ kind: 'storage_unit', id: row.id }), {
        label: row.readable_id,
        name: unitName(row.project_number, row.project_name, row.holes),
        stage,
        href: `/sample-storage/${encodeURIComponent(row.readable_id)}`,
      });
    }
  }

  if (projects.length > 0) {
    const { rows } = await db.query<{ id: string; project_number: string; name: string }>(
      'SELECT id, project_number, name FROM project WHERE id = ANY($1::uuid[])',
      [projects],
    );
    for (const row of rows) {
      faces.set(refKey({ kind: 'project', id: row.id }), {
        label: row.project_number,
        name: row.name,
        stage: PROJECT_STAGE,
        href: `/projects/${row.id}`,
      });
    }
  }

  if (programs.length > 0) {
    const { rows } = await db.query<{
      id: string;
      program_number: string | null;
      status: 'draft' | 'submitted' | 'closed';
      created_by_account_user_id: string;
      project_number: string;
    }>(
      `SELECT lp.id, lp.program_number, lp.status, lp.created_by_account_user_id,
              p.project_number
       FROM lab_program lp JOIN project p ON p.id = lp.project_id
       WHERE lp.id = ANY($1::uuid[])`,
      [programs],
    );
    for (const row of rows) {
      if (row.status === 'draft' && row.created_by_account_user_id !== user.userId) continue;
      faces.set(refKey({ kind: 'lab_program', id: row.id }), {
        // A draft has no number until it is submitted.
        label: row.program_number ?? 'Draft program',
        name: row.project_number,
        stage: LAB_PROGRAM_STATUS_STAGE[row.status],
        href: `/lab-testing/programs/${row.id}`,
      });
    }
  }

  if (sets.length > 0) {
    const { rows } = await db.query<{
      id: string;
      permanent_id: string | null;
      temporary_id: string | null;
      project_number: string;
    }>(
      `SELECT s.id, s.permanent_id, s.temporary_id, p.project_number
       FROM concrete_specimen_set s JOIN project p ON p.id = s.project_id
       WHERE s.id = ANY($1::uuid[])`,
      [sets],
    );
    for (const row of rows) {
      faces.set(refKey({ kind: 'specimen_set', id: row.id }), {
        label: row.permanent_id ?? row.temporary_id ?? 'Unnumbered set',
        name: row.project_number,
        // A set without its permanent number is still being entered (draft); a numbered set is
        // received lab work (lab). Testing and HOLD detail stay on the set's own page.
        stage: row.permanent_id === null ? 'draft' : 'lab',
        href: `/concrete/specimens/${row.id}`,
      });
    }
  }

  return faces;
}

/** "DEMO-2601 · TH26-01, TH26-02 +1", or the project name when no hole is recorded. */
function unitName(projectNumber: string, projectName: string, holes: string[]): string {
  if (holes.length === 0) return projectName;
  const shown = holes.slice(0, 2).join(', ');
  return `${projectNumber} · ${shown}${holes.length > 2 ? ` +${holes.length - 2}` : ''}`;
}
