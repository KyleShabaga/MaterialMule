import { isMyProject, projectListQuerySchema } from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import { buildProjectListQuery } from './project-list-query.js';

const ME = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';

describe('"Only mine" predicate (MM-T35 T1)', () => {
  it('includes projects where I am the PM/PE or the review engineer, nothing else', () => {
    expect(isMyProject({ pmPe: { id: ME }, reviewEngineer: null }, ME)).toBe(true);
    expect(isMyProject({ pmPe: { id: OTHER }, reviewEngineer: { id: ME } }, ME)).toBe(true);
    expect(isMyProject({ pmPe: { id: ME }, reviewEngineer: { id: ME } }, ME)).toBe(true);
    expect(isMyProject({ pmPe: { id: OTHER }, reviewEngineer: null }, ME)).toBe(false);
    expect(isMyProject({ pmPe: { id: OTHER }, reviewEngineer: { id: OTHER } }, ME)).toBe(false);
  });

  it('filters the SQL the same way, with the user only as a parameter', () => {
    const sql = buildProjectListQuery(projectListQuerySchema.parse({ mine: 'true' }), ME);
    expect(sql.where).toBe('WHERE (p.pm_pe_user_id = $1 OR p.review_engineer_user_id = $1)');
    expect(sql.params).toEqual([ME]);
    const all = buildProjectListQuery(projectListQuerySchema.parse({ mine: 'false' }), ME);
    expect(all.where).toBe('');
    expect(all.params).toEqual([]);
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
    expect(sql.where).toContain('p.pm_pe_user_id = $2');
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
