import { Injectable } from '@nestjs/common';
import type { LabRequestLink } from '@materialmule/shared';
import type { PoolClient } from 'pg';

/**
 * Finds lab requests that still reference a storage unit and aren't resolved. A project
 * correction is refused while any exist (D47): the links must be resolved first.
 */
export interface LabRequestLinkChecker {
  /** Called inside the correction transaction, after the unit row is locked. */
  unresolvedLinks(client: PoolClient, storageUnitId: string): Promise<LabRequestLink[]>;
}

export const LAB_REQUEST_LINK_CHECKER = Symbol('LabRequestLinkChecker');

/**
 * MM-T23: a unit is referenced by every program that isn't closed and either froze it into a
 * line's coverage (included, not a reviewed exclusion), has it chosen on a draft line, or names
 * it as a line's standalone source.
 * Submission takes FOR SHARE on the units it freezes, so a correction holding the unit's row lock
 * and a submission are serialised: whichever commits second sees the other.
 */
@Injectable()
export class ProgramLabRequestLinks implements LabRequestLinkChecker {
  async unresolvedLinks(client: PoolClient, storageUnitId: string): Promise<LabRequestLink[]> {
    const { rows } = await client.query<{
      id: string;
      program_number: string | null;
      project_number: string;
      status: string;
    }>(
      `SELECT lp.id, lp.program_number, p.project_number, lp.status
       FROM lab_program lp
       JOIN project p ON p.id = lp.project_id
       WHERE lp.status <> 'closed'
         AND (EXISTS (SELECT 1 FROM program_scope_snapshot s
                      WHERE s.program_id = lp.id AND s.storage_unit_id = $1 AND s.included)
              OR EXISTS (SELECT 1 FROM test_line_unit_choice c
                         JOIN test_line l ON l.id = c.line_id
                         WHERE l.program_id = lp.id AND c.storage_unit_id = $1)
              OR EXISTS (SELECT 1 FROM test_line l
                         WHERE l.program_id = lp.id AND l.source_storage_unit_id = $1))
       ORDER BY lp.submitted_at NULLS LAST, lp.created_at, lp.id`,
      [storageUnitId],
    );
    return rows.map((row) => ({
      id: row.id,
      label: row.program_number ?? `Draft program for ${row.project_number}`,
      status: row.status,
    }));
  }
}
