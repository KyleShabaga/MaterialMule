import { projectListQuerySchema } from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import { buildProjectListQuery } from './project-list-query.js';

const ME = '00000000-0000-4000-8000-0000000000aa';

describe('"My projects" filter (MM-T35 T1, D12)', () => {
  it('filters by the one involvement definition, with the user only as a parameter', () => {
    const sql = buildProjectListQuery(projectListQuerySchema.parse({ mine: 'true' }), ME);
    expect(sql.where).toMatch(/^WHERE p\.id IN \(SELECT i\.project_id FROM \(/);
    for (const source of [
      'p.lead_project_engineer_user_id = $1',
      'project_team_member',
      'project_reviewer_assignment',
      'acceptance_delegation',
      'project_report_issuer_grant',
    ]) {
      expect(sql.where).toContain(source);
    }
    expect(sql.where).not.toContain('review_engineer');
    expect(sql.params).toEqual([ME]);
    expect(sql.listParams).toEqual([ME]);
    expect(sql.userParam).toBe('$1');
    const all = buildProjectListQuery(projectListQuerySchema.parse({ mine: 'false' }), ME);
    expect(all.where).toBe('');
    expect(all.params).toEqual([]);
    // The list still labels involvement, so it gets the user as its own parameter.
    expect(all.listParams).toEqual([ME]);
    expect(all.userParam).toBe('$1');
  });
});

describe('buildProjectListQuery', () => {
  it('searches number, name and client with one escaped, lower-cased pattern', () => {
    const sql = buildProjectListQuery(
      projectListQuerySchema.parse({ search: ' River_50% ', mine: '1' }),
      ME,
    );
    expect(sql.params).toEqual(['%river\\_50\\%%', ME]);
    expect(sql.where).toContain('p.project_number_normalized LIKE $1');
    expect(sql.where).toContain('lower(p.name) LIKE $1');
    expect(sql.where).toContain('lower(p.client) LIKE $1');
    expect(sql.where).toContain('p.lead_project_engineer_user_id = $2');
    expect(sql.listParams).toEqual(sql.params);
  });

  it('defaults to number A–Z, 25 per page, and always ends with a unique tie-breaker', () => {
    const sql = buildProjectListQuery(projectListQuerySchema.parse({}), ME);
    expect(sql.orderBy).toBe('p.project_number_normalized COLLATE "C" ASC, p.id ASC');
    expect(sql.limit).toBe(25);
    expect(sql.offset).toBe(0);
  });

  it('sorts last receipt newest first by default with never-received projects last', () => {
    const sql = buildProjectListQuery(
      projectListQuerySchema.parse({ sort: 'last_receipt', page: '3', pageSize: '10' }),
      ME,
    );
    expect(sql.orderBy).toMatch(/^last_receipt_date DESC NULLS LAST, /);
    expect(sql.offset).toBe(20);
  });

  it('rejects page sizes above 100 and unknown sorts', () => {
    expect(projectListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(projectListQuerySchema.safeParse({ sort: 'client' }).success).toBe(false);
    expect(projectListQuerySchema.safeParse({ mine: 'maybe' }).success).toBe(false);
  });
});
