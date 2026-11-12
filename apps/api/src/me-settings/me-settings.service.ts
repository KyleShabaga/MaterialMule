import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DEFAULT_SIDEBAR_LAYOUT,
  DEFAULT_USER_PREFERENCES,
  LAB_TIME_ZONE,
  TABLE_IDS,
  normalizeHiddenColumns,
  normalizeSidebarLayout,
  normalizeUserPreferences,
  optionalColumnIds,
  tableIdSchema,
  type SidebarLayoutQuery,
  type SidebarLayoutResponse,
  type SidebarLayoutVersionConflict,
  type TableColumnsResponse,
  type TableColumnsVersionConflict,
  type TableId,
  type UpdateSidebarLayout,
  type UpdateTableColumns,
  type UpdateUserPreferences,
  type UserPreferencesResponse,
  type UserPreferencesVersionConflict,
} from '@materialmule/shared';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { readSetting, saveSetting, type StoredSetting } from './person-setting-store.js';

const isLab = (user: AuthUser) => user.accountType === 'shared_lab';

/**
 * Per-person sidebar layout (STRATA-41), preferences (STRATA-29) and table columns (STRATA-51).
 * Every read and write is the signed-in person's own: no route takes a person from the browser,
 * except the shared LAB account's read-only `?personId=` on the sidebar layout. LAB reads
 * defaults and never saves (the write routes refuse it at the guard).
 */
@Injectable()
export class MeSettingsService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Sidebar layout

  async sidebarLayout(user: AuthUser, query: SidebarLayoutQuery): Promise<SidebarLayoutResponse> {
    if (!isLab(user)) {
      if (query.personId !== undefined) {
        throw new BadRequestException({ code: 'person_id_not_allowed' });
      }
      return layoutResponse(await readSetting(this.database.pool, user.userId, 'sidebar_layout'));
    }
    if (query.personId === undefined) {
      return { ...DEFAULT_SIDEBAR_LAYOUT, version: 0, source: 'default', readOnly: true };
    }
    // The picked person: an active personal (or test) account. Their layout only, read-only.
    const { rows } = await this.database.pool.query(
      `SELECT 1 FROM app_user
       WHERE id = $1 AND status = 'active' AND account_type IN ('personal', 'test')`,
      [query.personId],
    );
    if (rows.length === 0) throw new NotFoundException({ code: 'person_not_found' });
    const stored = await readSetting(this.database.pool, query.personId, 'sidebar_layout');
    return {
      ...normalizeSidebarLayout(stored.value ?? DEFAULT_SIDEBAR_LAYOUT),
      version: stored.version,
      source: 'station_person',
      readOnly: true,
    };
  }

  async updateSidebarLayout(
    user: AuthUser,
    input: UpdateSidebarLayout,
  ): Promise<SidebarLayoutResponse> {
    const { version, ...layout } = input;
    const normalized = normalizeSidebarLayout(layout);
    const result = await saveSetting(
      this.database.pool,
      user.userId,
      'sidebar_layout',
      version,
      () => ({ ...normalized }),
    );
    if (!result.saved) {
      throw new ConflictException({
        code: 'version_conflict',
        current: layoutResponse(result.current),
      } satisfies SidebarLayoutVersionConflict);
    }
    return layoutResponse(result.setting);
  }

  // -------------------------------------------------------------------------------------------
  // Preferences

  async preferences(user: AuthUser): Promise<UserPreferencesResponse> {
    if (isLab(user)) {
      return {
        preferences: { ...DEFAULT_USER_PREFERENCES },
        version: 0,
        labTimeZone: LAB_TIME_ZONE,
        readOnly: true,
      };
    }
    return preferencesResponse(await readSetting(this.database.pool, user.userId, 'preferences'));
  }

  async updatePreferences(
    user: AuthUser,
    input: UpdateUserPreferences,
  ): Promise<UserPreferencesResponse> {
    const { version, ...changes } = input;
    const changed = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    );
    const result = await saveSetting(
      this.database.pool,
      user.userId,
      'preferences',
      version,
      (current) => ({ ...normalizeUserPreferences(current), ...changed }),
    );
    if (!result.saved) {
      throw new ConflictException({
        code: 'version_conflict',
        current: preferencesResponse(result.current),
      } satisfies UserPreferencesVersionConflict);
    }
    return preferencesResponse(result.setting);
  }

  // -------------------------------------------------------------------------------------------
  // Table columns

  async tableColumns(user: AuthUser): Promise<TableColumnsResponse> {
    if (isLab(user)) return { ...columnsOf(null), version: 0, readOnly: true };
    const stored = await readSetting(this.database.pool, user.userId, 'table_columns');
    return columnsResponse(stored);
  }

  /** 400 `unknown_table` for a table missing from TABLE_COLUMN_REGISTRY. */
  assertKnownTable(tableIdParam: string): TableId {
    const table = tableIdSchema.safeParse(tableIdParam);
    if (!table.success) throw new BadRequestException({ code: 'unknown_table' });
    return table.data;
  }

  /** Validates the table and columns before anything is read or written. */
  async updateTableColumns(
    user: AuthUser,
    tableIdParam: string,
    input: UpdateTableColumns,
  ): Promise<TableColumnsResponse> {
    const tableId = this.assertKnownTable(tableIdParam);
    const optional = optionalColumnIds(tableId);
    if (input.hidden.some((id) => !optional.includes(id))) {
      throw new BadRequestException({ code: 'invalid_column' });
    }
    const hidden = normalizeHiddenColumns(tableId, input.hidden);
    const result = await saveSetting(
      this.database.pool,
      user.userId,
      'table_columns',
      input.version,
      (current) => {
        // Keep only registered tables, normalized, then replace this one.
        const tables: Record<string, string[]> = {};
        for (const id of TABLE_IDS) {
          if (current && Array.isArray(current[id])) {
            tables[id] = normalizeHiddenColumns(id, current[id]);
          }
        }
        tables[tableId] = hidden;
        return tables;
      },
    );
    if (!result.saved) {
      throw new ConflictException({
        code: 'version_conflict',
        current: columnsResponse(result.current),
      } satisfies TableColumnsVersionConflict);
    }
    return columnsResponse(result.setting);
  }
}

function layoutResponse(stored: StoredSetting): SidebarLayoutResponse {
  return {
    ...normalizeSidebarLayout(stored.value ?? DEFAULT_SIDEBAR_LAYOUT),
    version: stored.version,
    source: stored.value === null ? 'default' : 'own',
    readOnly: false,
  };
}

function preferencesResponse(stored: StoredSetting): UserPreferencesResponse {
  return {
    preferences: normalizeUserPreferences(stored.value),
    version: stored.version,
    labTimeZone: LAB_TIME_ZONE,
    readOnly: false,
  };
}

/** Stored as `{ <tableId>: hiddenIds[] }`; a table never saved uses the registry defaults. */
function columnsOf(value: Record<string, unknown> | null): Pick<TableColumnsResponse, 'tables'> {
  const tables: TableColumnsResponse['tables'] = {};
  for (const id of TABLE_IDS) {
    tables[id] = { hidden: normalizeHiddenColumns(id, value?.[id]) };
  }
  return { tables };
}

function columnsResponse(stored: StoredSetting): TableColumnsResponse {
  return { ...columnsOf(stored.value), version: stored.version, readOnly: false };
}
