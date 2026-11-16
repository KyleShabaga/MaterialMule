import {
  DEFAULT_STATION_ROWS,
  normalizeStationRows,
  stationConfigSchema,
  stationTodaySchema,
  type StationConfig,
  type StationToday,
} from '@materialmule/shared';
import { apiFetch } from '../../api/client';

// The LAB station's Today (STRATA-20, 21, 63): the "At this station" counts and the station's
// row settings. Every call resolves; null means it couldn't be read (the page says so on the
// part that failed and keeps the rest working).

/** `GET /api/station/today`; null when the whole list couldn't load. */
export async function fetchStationToday(): Promise<StationToday | null> {
  try {
    const response = await apiFetch('/api/station/today');
    if (!response.ok) return null;
    const parsed = stationTodaySchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function configPath(id: string): string {
  return `/api/station/config/${encodeURIComponent(id)}`;
}

/** The defaults, as the server answers for a station that was never set up (version 0). */
export function defaultStationConfig(id: string): StationConfig {
  return {
    stationId: id,
    rows: DEFAULT_STATION_ROWS,
    version: 0,
    updatedBy: null,
    updatedAt: null,
  };
}

function canonical(config: StationConfig): StationConfig {
  return { ...config, rows: normalizeStationRows(config.rows) };
}

/** `GET /api/station/config/:stationId`; null when it couldn't be read. */
export async function fetchStationConfig(id: string): Promise<StationConfig | null> {
  try {
    const response = await apiFetch(configPath(id));
    if (!response.ok) return null;
    const parsed = stationConfigSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? canonical(parsed.data) : null;
  } catch {
    return null;
  }
}

export type SaveStationConfigResult =
  | { state: 'saved'; config: StationConfig }
  /** Someone saved since `version` was read: reload and say so. */
  | { state: 'conflict' }
  | { state: 'failed' };

/** `PUT /api/station/config/:stationId` with the full row list and the version it was based on. */
export async function saveStationConfig(
  id: string,
  rows: StationConfig['rows'],
  version: number,
): Promise<SaveStationConfigResult> {
  try {
    const response = await apiFetch(configPath(id), {
      method: 'PUT',
      body: JSON.stringify({ rows, version }),
    });
    if (response.status === 409) return { state: 'conflict' };
    if (!response.ok) return { state: 'failed' };
    const parsed = stationConfigSchema.safeParse(await response.json().catch(() => null));
    return parsed.success
      ? { state: 'saved', config: canonical(parsed.data) }
      : { state: 'failed' };
  } catch {
    return { state: 'failed' };
  }
}
