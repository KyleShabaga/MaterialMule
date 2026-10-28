import {
  LABELS_TO_CHECK_DAYS,
  type RecentlyReceivedItem,
  type RecentlyReceivedQuery,
  type RecentlyReceivedResponse,
} from '@materialmule/shared';
import type { Pool } from 'pg';
import { wallClockAt } from '../auth/calendar-month.js';
import { loadHoleSummaries } from '../storage-units/hole-summaries.js';
import { loadSampleIdentities, membershipOf } from '../storage-units/sample-identity.js';

// Dashboard "Recently received" (approved design 2026-10-27). Same order as the inventory's
// received-date sort (newest date first, then storage unit ID), so it uses the same index and
// matches Sample Storage's default view.

/** Calendar dates the dashboard counts from, in the business time zone (YYYY-MM-DD). */
export interface DashboardDates {
  today: string;
  /** Monday of this week. */
  weekStart: string;
  /** First day "Labels to check" looks at. */
  labelsSince: string;
}

function isoDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export function dashboardDates(now: Date, timeZone: string): DashboardDates {
  const { year, month, day } = wallClockAt(now.getTime(), timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  const sinceMonday = (weekday + 6) % 7;
  return {
    today: isoDate(year, month, day),
    weekStart: isoDate(year, month, day - sinceMonday),
    labelsSince: isoDate(year, month, day - LABELS_TO_CHECK_DAYS),
  };
}

// The unit's newest print job, if any. print_job_item_unit_idx finds the unit's jobs.
const LATEST_PRINT = `LEFT JOIN LATERAL (
       SELECT pj.status, pj.attempts, pj.printer_message, pj.physically_confirmed_at
       FROM print_job_item pji JOIN print_job pj ON pj.id = pji.print_job_id
       WHERE pji.storage_unit_id = su.id
       ORDER BY pj.created_at DESC, pj.id DESC
       LIMIT 1) lp ON true`;

const NEEDS_LABEL_CHECK = `lp.status IN ('sent', 'uncertain') AND lp.physically_confirmed_at IS NULL`;

const ORDER = `su.received_date DESC, su.readable_id COLLATE "C" DESC`;

interface Row {
  id: string;
  readable_id: string;
  unit_type: RecentlyReceivedItem['unitType'];
  status: RecentlyReceivedItem['status'];
  received_date: string;
  received_at: Date;
  receiver_initials: string;
  receiver_name: string;
  project_id: string;
  project_number: string;
  project_name: string;
  client: string;
  location_id: string;
  location_code: string;
  location_name: string;
  print_status: NonNullable<RecentlyReceivedItem['latestPrint']>['status'] | null;
  print_attempts: number | null;
  printer_message: string | null;
  physically_confirmed_at: Date | null;
}

export async function queryRecentlyReceived(
  pool: Pool,
  query: RecentlyReceivedQuery,
  dates: DashboardDates,
): Promise<RecentlyReceivedResponse> {
  // Disposed units leave the dashboard, as they leave Sample Storage's default view.
  const where = [`su.status <> 'disposed'`];
  const params: unknown[] = [];
  if (query.show === 'today') {
    params.push(dates.today);
    where.push(`su.received_date = $${params.length}::date`);
  } else if (query.show === 'labels') {
    params.push(dates.labelsSince);
    where.push(`su.received_date >= $${params.length}::date`, NEEDS_LABEL_CHECK);
  }
  params.push(query.limit);

  const [page, counts] = await Promise.all([
    pool.query<Row>(
      `SELECT su.id, su.readable_id, su.unit_type, su.status,
              su.received_date::text AS received_date, r.confirmed_at AS received_at,
              r.receiver_initials_snapshot AS receiver_initials,
              r.receiver_name_snapshot AS receiver_name,
              p.id AS project_id, p.project_number, p.name AS project_name, p.client,
              l.id AS location_id, l.code AS location_code, l.name AS location_name,
              lp.status AS print_status, lp.attempts AS print_attempts, lp.printer_message,
              lp.physically_confirmed_at
       FROM storage_unit su
       ${LATEST_PRINT}
       JOIN receipt r ON r.id = su.receipt_id
       JOIN project p ON p.id = su.project_id
       JOIN location l ON l.id = su.current_location_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${ORDER}
       LIMIT $${params.length}`,
      params,
    ),
    pool.query<{ total: number; today: number; week: number; labels: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE su.received_date = $1::date)::int AS today,
              count(*) FILTER (WHERE su.received_date >= $2::date)::int AS week,
              (SELECT count(*)::int FROM storage_unit su
               ${LATEST_PRINT}
               WHERE su.status <> 'disposed' AND su.received_date >= $3::date
                 AND ${NEEDS_LABEL_CHECK}) AS labels
       FROM storage_unit su
       WHERE su.status <> 'disposed'`,
      [dates.today, dates.weekStart, dates.labelsSince],
    ),
  ]);

  const rows = page.rows;
  const ids = rows.map((row) => row.id);
  const holes = await loadHoleSummaries(pool, ids);
  const identities = await loadSampleIdentities(pool, ids);
  const count = counts.rows[0]!;
  return {
    items: rows.map((row) => ({
      id: row.id,
      readableId: row.readable_id,
      unitType: row.unit_type,
      status: row.status,
      receivedDate: row.received_date,
      receivedAt: row.received_at.toISOString(),
      receiver: { initials: row.receiver_initials, name: row.receiver_name },
      project: {
        id: row.project_id,
        projectNumber: row.project_number,
        name: row.project_name,
        client: row.client,
      },
      holes: holes.get(row.id) ?? [],
      sample: identities.get(row.id)?.sample ?? null,
      bulkGroup: membershipOf(identities.get(row.id)),
      location: { id: row.location_id, code: row.location_code, name: row.location_name },
      latestPrint:
        row.print_status === null
          ? null
          : {
              status: row.print_status,
              attempts: row.print_attempts ?? 0,
              printerMessage: row.printer_message,
              physicallyConfirmedAt: row.physically_confirmed_at?.toISOString() ?? null,
            },
    })),
    total:
      query.show === 'today' ? count.today : query.show === 'labels' ? count.labels : count.total,
    receivedThisWeek: count.week,
    labelsToCheck: count.labels,
  };
}
