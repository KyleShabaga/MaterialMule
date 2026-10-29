import { projectListSortDirection, type ProjectListQuery } from '@materialmule/shared';
import { involvementSql } from '../project-access/involvement.js';
import { likeEscape } from './projects.service.js';

/** Parameterised pieces of the projects list query. Values only ever travel as parameters. */
export interface ProjectListSql {
  /** WHERE clause over `project p` (empty when nothing narrows the list). */
  where: string;
  orderBy: string;
  params: unknown[];
  /** `params` plus, when the WHERE clause doesn't use it already, the signed-in user. */
  listParams: unknown[];
  /** The placeholder in `listParams` holding the signed-in user, for the involvement column. */
  userParam: string;
  limit: number;
  offset: number;
}

/**
 * Builds the projects list query (MM-T35). Search matches number, name or client (contains,
 * ignoring case); "My projects" keeps projects `userId` is actively involved in (D12, MM-AO03:
 * lead, team member, reviewer, acceptance delegate or report issuer; `involvementSql`). The
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
  let user: string | null = null;
  if (query.mine) {
    user = param(userId);
    where.push(`p.id IN (SELECT i.project_id FROM (${involvementSql(user)}) i)`);
  }
  if (query.waitingForLead) {
    // D02 (MM-AO04): projects with no effective Lead Project Engineer (partial index).
    where.push('p.lead_project_engineer_user_id IS NULL');
  }
  const listParams = [...params];
  const userParam = user ?? `$${listParams.push(userId)}`;

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
    listParams,
    userParam,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
}
