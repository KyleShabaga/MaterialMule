import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  companyHolidayListQuerySchema,
  concreteSupplierListQuerySchema,
  createCompanyHolidayRequestSchema,
  createConcreteSupplierRequestSchema,
  removeCompanyHolidayRequestSchema,
  updateCompanyHolidayRequestSchema,
  updateConcreteSupplierRequestSchema,
  type CompanyHoliday,
  type CompanyHolidayList,
  type ConcreteHolidayDates,
  type ConcreteSupplier,
  type ConcreteSupplierList,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser, type Permission } from '../auth/policy.js';
import { asLocked, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { parseBody } from '../validation/parse-body.js';

// MM-V2-C37: concrete suppliers and the company holiday calendar (migration 0028). Every active
// session reads both (inventory.read); suppliers are managed by Lab Managers and admins
// (concrete_settings.supplier.manage), holidays by admins (concrete_settings.holiday.manage).
// Order of checks: route permission (403, before the body) → 404 → 400 body → under the lock (the
// row FOR UPDATE, then the actor's account FOR SHARE, D09) the final permission check → 409.
// Every change is audited in the same transaction.

type Db = Pool | PoolClient;

const SUPPLIER = 'concrete_settings.supplier.manage' as const satisfies Permission;
const HOLIDAY = 'concrete_settings.holiday.manage' as const satisfies Permission;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const forbidden = () => new ForbiddenException({ code: 'forbidden' });

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

function supplierExists(): ConflictException {
  return new ConflictException({
    code: 'supplier_exists',
    message: 'A supplier with this name is already listed.',
    errors: [{ field: 'name', code: 'supplier_exists', message: 'Already listed' }],
  });
}

function holidayExists(): ConflictException {
  return new ConflictException({
    code: 'holiday_exists',
    message: 'This date is already a holiday.',
    errors: [{ field: 'holidayOn', code: 'holiday_exists', message: 'Already a holiday' }],
  });
}

interface SupplierRow {
  id: string;
  name: string;
  plant_names: string[];
  active: boolean;
  linked_mix_count: number;
  created_at: Date;
  created_by_user_id: string;
  created_by_initials_snapshot: string | null;
  created_by_name_snapshot: string;
  updated_at: Date;
  version: number;
}

const SELECT_SUPPLIER = `SELECT s.id, s.name, s.plant_names, s.active,
    (SELECT count(*)::int FROM concrete_mix m WHERE m.supplier_id = s.id) AS linked_mix_count,
    s.created_at, s.created_by_user_id, s.created_by_initials_snapshot,
    s.created_by_name_snapshot, s.updated_at, s.version
  FROM concrete_supplier s`;

function toSupplier(row: SupplierRow): ConcreteSupplier {
  return {
    id: row.id,
    name: row.name,
    plantNames: row.plant_names,
    active: row.active,
    linkedMixCount: row.linked_mix_count,
    createdAt: row.created_at.toISOString(),
    createdBy: {
      userId: row.created_by_user_id,
      initials: row.created_by_initials_snapshot,
      name: row.created_by_name_snapshot,
    },
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

interface HolidayRow {
  id: string;
  holiday_on: string;
  name: string;
  source: CompanyHoliday['source'];
  created_by_user_id: string | null;
  created_by_initials_snapshot: string | null;
  created_by_name_snapshot: string | null;
  updated_at: Date;
  removed_at: Date | null;
  version: number;
}

const SELECT_HOLIDAY = `SELECT id, to_char(holiday_on, 'YYYY-MM-DD') AS holiday_on, name, source,
    created_by_user_id, created_by_initials_snapshot, created_by_name_snapshot, updated_at,
    removed_at, version
  FROM company_holiday`;

function toHoliday(row: HolidayRow): CompanyHoliday {
  return {
    id: row.id,
    holidayOn: row.holiday_on,
    name: row.name,
    source: row.source,
    createdBy: row.created_by_user_id
      ? {
          userId: row.created_by_user_id,
          initials: row.created_by_initials_snapshot,
          name: row.created_by_name_snapshot ?? '',
        }
      : null,
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

/**
 * The company holiday dates in effect (YYYY-MM-DD), for `concreteTargetDateFlags`. A small table
 * (about ten rows a year), read whole per request so a change applies at once.
 */
export async function loadHolidayDates(db: Db): Promise<ConcreteHolidayDates> {
  const { rows } = await db.query<{ holiday_on: string }>(
    `SELECT to_char(holiday_on, 'YYYY-MM-DD') AS holiday_on FROM company_holiday
     WHERE removed_at IS NULL`,
  );
  return new Set(rows.map((row) => row.holiday_on));
}

/** A listed supplier's link view, or undefined for an unknown id. */
export async function findSupplier(
  db: Db,
  id: string,
  lock: '' | 'FOR SHARE' = '',
): Promise<{ id: string; name: string; active: boolean } | undefined> {
  if (!UUID_PATTERN.test(id)) return undefined;
  const { rows } = await db.query<{ id: string; name: string; active: boolean }>(
    `SELECT id, name, active FROM concrete_supplier WHERE id = $1 ${lock}`,
    [id],
  );
  return rows[0];
}

@Injectable()
export class ConcreteReferenceDataService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Suppliers
  // -------------------------------------------------------------------------------------------

  async listSuppliers(rawQuery: unknown, user: AuthUser): Promise<ConcreteSupplierList> {
    const query = parseBody(concreteSupplierListQuerySchema, rawQuery);
    const { rows } = await this.database.pool.query<SupplierRow>(
      `${SELECT_SUPPLIER} ${query.includeInactive ? '' : 'WHERE s.active'}
       ORDER BY lower(s.name), s.id`,
    );
    return { items: rows.map(toSupplier), canManage: can(user, SUPPLIER) };
  }

  async createSupplier(
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSupplier> {
    if (!can(user, SUPPLIER)) throw forbidden();
    const input = parseBody(createConcreteSupplierRequestSchema, body);
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const standing = await lockStanding(client, [user.userId]);
        if (!can(asLocked(user, standing), SUPPLIER)) throw forbidden();
        const by = standing.get(user.userId)!;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO concrete_supplier
             (name, plant_names, created_by_user_id, created_by_initials_snapshot,
              created_by_name_snapshot)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [input.name, input.plantNames, by.userId, by.initials, by.displayName],
        );
        const id = rows[0]!.id;
        await recordAudit(client, {
          action: 'concrete_supplier.created',
          entityType: 'concrete_supplier',
          entityId: id,
          actor,
          before: null,
          after: { name: input.name, plantNames: input.plantNames, active: true },
          requestId,
        });
        return (await this.supplier(client, id))!;
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_supplier_name_key')) throw supplierExists();
      throw error;
    }
  }

  async updateSupplier(
    id: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSupplier> {
    if (!can(user, SUPPLIER)) throw forbidden();
    if (!(await this.supplier(this.database.pool, id))) {
      throw new NotFoundException({ code: 'supplier_not_found' });
    }
    const input = parseBody(updateConcreteSupplierRequestSchema, body);
    try {
      return await withTransaction(this.database.pool, async (client) => {
        await client.query('SELECT 1 FROM concrete_supplier WHERE id = $1 FOR UPDATE', [id]);
        const standing = await lockStanding(client, [user.userId]);
        if (!can(asLocked(user, standing), SUPPLIER)) throw forbidden();
        const current = (await this.supplier(client, id))!;
        if (current.version !== input.version) {
          throw new ConflictException({ code: 'version_conflict', current });
        }
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        const next = { name: current.name, plantNames: current.plantNames, active: current.active };
        if (input.name !== undefined && input.name !== current.name) {
          before.name = current.name;
          after.name = next.name = input.name;
        }
        if (
          input.plantNames !== undefined &&
          JSON.stringify(input.plantNames) !== JSON.stringify(current.plantNames)
        ) {
          before.plantNames = current.plantNames;
          after.plantNames = next.plantNames = input.plantNames;
        }
        if (input.active !== undefined && input.active !== current.active) {
          before.active = current.active;
          after.active = next.active = input.active;
        }
        if (Object.keys(after).length === 0) return current;
        await client.query(
          `UPDATE concrete_supplier
           SET name = $2, plant_names = $3, active = $4, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [id, next.name, next.plantNames, next.active],
        );
        await recordAudit(client, {
          action: 'concrete_supplier.updated',
          entityType: 'concrete_supplier',
          entityId: id,
          actor,
          reason: input.reason ?? null,
          before,
          after,
          requestId,
        });
        return (await this.supplier(client, id))!;
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_supplier_name_key')) throw supplierExists();
      throw error;
    }
  }

  private async supplier(db: Db, id: string): Promise<ConcreteSupplier | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const { rows } = await db.query<SupplierRow>(`${SELECT_SUPPLIER} WHERE s.id = $1`, [id]);
    return rows[0] ? toSupplier(rows[0]) : null;
  }

  // -------------------------------------------------------------------------------------------
  // Holidays
  // -------------------------------------------------------------------------------------------

  async listHolidays(rawQuery: unknown, user: AuthUser): Promise<CompanyHolidayList> {
    const query = parseBody(companyHolidayListQuerySchema, rawQuery);
    const params: unknown[] = [];
    let where = 'WHERE removed_at IS NULL';
    if (query.year !== undefined) {
      params.push(query.year);
      where += ` AND extract(year FROM holiday_on) = $1`;
    }
    const { rows } = await this.database.pool.query<HolidayRow>(
      `${SELECT_HOLIDAY} ${where} ORDER BY holiday_on`,
      params,
    );
    return {
      year: query.year ?? null,
      items: rows.map(toHoliday),
      canManage: can(user, HOLIDAY),
    };
  }

  async createHoliday(
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<CompanyHoliday> {
    if (!can(user, HOLIDAY)) throw forbidden();
    const input = parseBody(createCompanyHolidayRequestSchema, body);
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const standing = await lockStanding(client, [user.userId]);
        if (!can(asLocked(user, standing), HOLIDAY)) throw forbidden();
        const by = standing.get(user.userId)!;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO company_holiday
             (holiday_on, name, source, created_by_user_id, created_by_initials_snapshot,
              created_by_name_snapshot)
           VALUES ($1, $2, 'company', $3, $4, $5) RETURNING id`,
          [input.holidayOn, input.name, by.userId, by.initials, by.displayName],
        );
        const id = rows[0]!.id;
        await recordAudit(client, {
          action: 'company_holiday.added',
          entityType: 'company_holiday',
          entityId: id,
          actor,
          before: null,
          after: { holidayOn: input.holidayOn, name: input.name, source: 'company' },
          requestId,
        });
        return (await this.holiday(client, id))!;
      });
    } catch (error) {
      if (isConstraint(error, 'company_holiday_date_key')) throw holidayExists();
      throw error;
    }
  }

  async renameHoliday(
    id: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<CompanyHoliday> {
    return this.changeHoliday(id, user, async (client, current) => {
      const input = parseBody(updateCompanyHolidayRequestSchema, body);
      this.checkVersion(current, input.version);
      if (input.name === current.name) return current;
      await client.query(
        `UPDATE company_holiday SET name = $2, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, input.name],
      );
      await recordAudit(client, {
        action: 'company_holiday.renamed',
        entityType: 'company_holiday',
        entityId: id,
        actor,
        before: { name: current.name },
        after: { name: input.name },
        requestId,
      });
      return (await this.holiday(client, id))!;
    });
  }

  async removeHoliday(
    id: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<CompanyHoliday> {
    return this.changeHoliday(id, user, async (client, current, by) => {
      const input = parseBody(removeCompanyHolidayRequestSchema, body);
      this.checkVersion(current, input.version);
      await client.query(
        `UPDATE company_holiday
         SET removed_at = now(), removed_by_user_id = $2, removed_by_initials_snapshot = $3,
             removed_by_name_snapshot = $4, removal_reason = $5, version = version + 1,
             updated_at = now()
         WHERE id = $1`,
        [id, by.userId, by.initials, by.displayName, input.reason],
      );
      await recordAudit(client, {
        action: 'company_holiday.removed',
        entityType: 'company_holiday',
        entityId: id,
        actor,
        reason: input.reason,
        before: { holidayOn: current.holidayOn, name: current.name, source: current.source },
        after: { removed: true },
        requestId,
      });
      const { rows } = await client.query<HolidayRow>(`${SELECT_HOLIDAY} WHERE id = $1`, [id]);
      return toHoliday(rows[0]!);
    });
  }

  private async changeHoliday(
    id: string,
    user: AuthUser,
    work: (
      client: PoolClient,
      current: CompanyHoliday,
      by: { userId: string; initials: string | null; displayName: string },
    ) => Promise<CompanyHoliday>,
  ): Promise<CompanyHoliday> {
    if (!can(user, HOLIDAY)) throw forbidden();
    // 404 for an unknown or removed holiday, before the body.
    if (!(await this.holiday(this.database.pool, id))) {
      throw new NotFoundException({ code: 'holiday_not_found' });
    }
    return withTransaction(this.database.pool, async (client) => {
      await client.query('SELECT 1 FROM company_holiday WHERE id = $1 FOR UPDATE', [id]);
      const standing = await lockStanding(client, [user.userId]);
      if (!can(asLocked(user, standing), HOLIDAY)) throw forbidden();
      const current = await this.holiday(client, id);
      if (!current) throw new NotFoundException({ code: 'holiday_not_found' });
      return work(client, current, standing.get(user.userId)!);
    });
  }

  private checkVersion(current: CompanyHoliday, version: number): void {
    if (current.version !== version) {
      throw new ConflictException({ code: 'version_conflict', current });
    }
  }

  /** A holiday in effect (removed ones are gone from every view). */
  private async holiday(db: Db, id: string): Promise<CompanyHoliday | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const { rows } = await db.query<HolidayRow>(
      `${SELECT_HOLIDAY} WHERE id = $1 AND removed_at IS NULL`,
      [id],
    );
    return rows[0] ? toHoliday(rows[0]) : null;
  }
}
