import { projectListSortDirection, type ProjectListQuery } from '@trapezoid/shared';
import { likeEscape } from './projects.service.js';

/** Parameterised pieces of the projects list query. Values only ever travel as parameters. */
export interface ProjectListSql {
  /** WHERE clause over `project p` (empty when nothing narrows the list). */
  where: string;
  orderBy: string;
  params: unknown[];
  limit: number;
  offset: number;
}

/**
 * Builds the projects list query (TRP-T35). Search matches number, name or client (contains,
 * ignoring case); "Only mine" keeps projects where `userId` is the PM/PE or review engineer. The
 * project number (then ID) ends every sort so pages never overlap or skip.
 */
export function buildProjectListQuery(query: ProjectListQuery, userId: string): ProjectListSql {
  const params: unknown[] = [];
  const where: string[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const search = query.search?.trim().toLowerCase();
  if (search) {
    const pattern = param(`%${likeEscape(search)}%`);
    where.push(
      `(p.project_number_normalized LIKE ${pattern} OR lower(p.name) LIKE ${pattern}` +
        ` OR lower(p.client) LIKE ${pattern})`,
    );
  }
  if (query.mine) {
    const user = param(userId);
    where.push(`(p.pm_pe_user_id = ${user} OR p.review_engineer_user_id = ${user})`);
  }

  const dir = projectListSortDirection(query) === 'asc' ? 'ASC' : 'DESC';
  const tieBreak = `p.project_number_normalized COLLATE "C" ${dir}, p.id ${dir}`;
  let orderBy: string;
  switch (query.sort) {
    case 'name':
      orderBy = `lower(p.name) ${dir}, ${tieBreak}`;
      break;
    case 'last_receipt':
      // Projects without a receipt come last in either direction.
      orderBy = `last_receipt_date ${dir} NULLS LAST, ${tieBreak}`;
      break;
    default:
      orderBy = tieBreak;
  }

  return {
    where: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    orderBy,
    params,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
}
