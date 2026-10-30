import { ConflictException, Injectable } from '@nestjs/common';
import { buildSampleTags, type SampleTagRule, type SampleTagSheet } from '@materialmule/shared';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { LabProgramsService } from './programs.service.js';

/**
 * Printable sample ID tags (MM-T69), computed from the program's current requests and the
 * catalogue's tag settings each time. Read-only: printing never writes to a program or request.
 */
@Injectable()
export class SampleTagsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly programs: LabProgramsService,
  ) {}

  async sheet(id: string, user: AuthUser): Promise<SampleTagSheet> {
    // Same visibility as the program itself (404 for a missing program or someone else's draft).
    const program = await this.programs.get(id, user);
    if (program.status === 'draft') {
      throw new ConflictException({
        code: 'program_not_submitted',
        message: 'Sample ID tags are available once the program is submitted.',
      });
    }
    const testTypeIds = [
      ...new Set(program.lines.flatMap((line) => line.requests.map((r) => r.testTypeId))),
    ];
    const { rows } = await this.database.pool.query<{
      id: string;
      sample_tag_mode: SampleTagRule['mode'];
      sample_tag_group: string | null;
    }>('SELECT id, sample_tag_mode, sample_tag_group FROM test_type WHERE id = ANY ($1::uuid[])', [
      testTypeIds,
    ]);
    const rules = new Map<string, SampleTagRule>(
      rows.map((row) => [row.id, { mode: row.sample_tag_mode, group: row.sample_tag_group }]),
    );
    return buildSampleTags(program, rules);
  }
}
