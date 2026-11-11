import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { activityResponseSchema, authProvidersResponseSchema } from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAudit, type AuditEvent } from '../audit/audit.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { withTransaction } from '../db/transaction.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { toActivityItem } from './activity.js';

function event(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: 'e1',
    occurredAt: new Date('2026-10-25T16:42:00Z'),
    action: 'receipt.confirmed',
    entityType: 'receipt',
    entityId: 'r1',
    actorUserId: 'u1',
    actorAccountType: 'shared_lab',
    actorInitials: 'AT',
    actorName: 'Alex Tester',
    receiverUserId: null,
    receiverInitials: null,
    receiverName: null,
    reason: null,
    before: null,
    after: null,
    requestId: null,
    ...overrides,
  };
}

describe('toActivityItem (T1)', () => {
  it('describes a receipt with its units, project and a link', () => {
    const item = toActivityItem(
      event({
        after: { readableIds: ['BKT-2026-000014', 'BKT-2026-000015'], projectNumber: 'DEMO-2601' },
      }),
    );
    expect(item.summary).toBe('AT received BKT-2026-000014 and 1 more for DEMO-2601');
    // Sample Storage filtered to the receipt's units, disposed ones included (no receipt page yet).
    expect(item.href).toBe('/sample-storage?receiptId=r1&status=all');
  });

  it('describes corrections and reprints by storage unit ID', () => {
    expect(
      toActivityItem(
        event({ action: 'storage_unit.corrected', after: { readableId: 'BKT-2026-000014' } }),
      ),
    ).toMatchObject({
      summary: 'AT corrected BKT-2026-000014',
      href: '/sample-storage/BKT-2026-000014',
    });
    expect(
      toActivityItem(
        event({ action: 'label.reprint_requested', after: { readableId: 'BKT-2026-000014' } }),
      ).summary,
    ).toBe('AT reprinted the label for BKT-2026-000014');
  });

  it('MM-T79 T1: a location label print or reprint request names the location and links to Settings → Locations', () => {
    const location = { target: 'location', locationId: 'l1', locationCode: 'WH-C1' };
    expect(
      toActivityItem(
        event({ action: 'label.print_requested', actorAccountType: 'personal', after: location }),
      ),
    ).toMatchObject({
      summary: 'AT requested the location label for WH-C1',
      href: '/settings/locations',
    });
    expect(
      toActivityItem(
        event({ action: 'label.reprint_requested', actorAccountType: 'personal', after: location }),
      ),
    ).toMatchObject({
      summary: 'AT requested a reprint of the location label for WH-C1',
      href: '/settings/locations',
    });
    // At a LAB station, the person it was printed for, as recorded.
    expect(
      toActivityItem(
        event({
          action: 'label.print_requested',
          actorInitials: null,
          actorName: 'LAB',
          receiverInitials: 'RE',
          receiverName: 'Riley Example',
          after: location,
        }),
      ).summary,
    ).toBe('LAB requested the location label for WH-C1 (for RE)');
  });

  it('MM-T79 AC3: storage unit label prints read as before', () => {
    const personal = { actorAccountType: 'personal' as const };
    expect(
      toActivityItem(
        event({
          ...personal,
          action: 'label.print_requested',
          after: { readableIds: ['BKT-2026-000014', 'BKT-2026-000015'] },
        }),
      ),
    ).toMatchObject({ summary: 'AT printed labels for BKT-2026-000014 and 1 more', href: null });
    expect(
      toActivityItem(
        event({
          ...personal,
          action: 'label.reprint_requested',
          after: { readableId: 'BKT-2026-000014' },
        }),
      ),
    ).toMatchObject({
      summary: 'AT reprinted the label for BKT-2026-000014',
      href: '/sample-storage/BKT-2026-000014',
    });
  });

  it('MM-T61: at a LAB station names the receiver as recorded, not just the account', () => {
    const lab = {
      actorInitials: null,
      actorName: 'LAB',
      receiverInitials: 'RE',
      receiverName: 'Riley Example',
    };
    expect(
      toActivityItem(
        event({
          ...lab,
          after: {
            readableIds: ['BKT-2026-000032', 'BKT-2026-000033', 'BKT-2026-000034'],
            projectNumber: 'DEMO-2601',
          },
        }),
      ).summary,
    ).toBe('LAB for RE received BKT-2026-000032 and 2 more for DEMO-2601');
    expect(
      toActivityItem(
        event({
          ...lab,
          action: 'label.print_requested',
          after: { readableIds: ['BKT-2026-000032', 'BKT-2026-000033'] },
        }),
      ).summary,
    ).toBe('LAB printed labels for BKT-2026-000032 and 1 more (for RE)');
    // Personal accounts are unchanged, even with a receiver on the event.
    expect(
      toActivityItem(
        event({
          actorAccountType: 'personal',
          receiverInitials: 'RE',
          after: { readableIds: ['BKT-2026-000032'], projectNumber: 'DEMO-2601' },
        }),
      ).summary,
    ).toBe('AT received BKT-2026-000032 for DEMO-2601');
  });

  it('Field Ledger: names moves and disposals by the unit ID the caller looked up', () => {
    const moved = toActivityItem(
      event({
        action: 'storage_unit.moved',
        entityType: 'storage_unit',
        after: { location: { code: 'WH-C2', name: 'Warehouse C2' }, station: 'x' },
      }),
      'BKT-2026-000142',
    );
    expect(moved).toMatchObject({
      summary: 'AT moved BKT-2026-000142 to Warehouse C2',
      ref: 'BKT-2026-000142',
      href: '/sample-storage/BKT-2026-000142',
    });
    expect(
      toActivityItem(
        event({
          action: 'storage_unit.moved',
          entityType: 'storage_unit',
          after: { location: { code: 'WH-C2', name: 'Warehouse C2' }, confirmedInPlace: true },
        }),
        'BKT-2026-000142',
      ).summary,
    ).toBe('AT confirmed BKT-2026-000142 at Warehouse C2');
    expect(
      toActivityItem(
        event({ action: 'disposal.removed', entityType: 'storage_unit', after: { route: 'x' } }),
        'CT-2025-000208',
      ),
    ).toMatchObject({
      summary: 'AT recorded the disposal of CT-2025-000208',
      ref: 'CT-2025-000208',
    });
  });

  it('Field Ledger: ref is the one record, else the project', () => {
    expect(
      toActivityItem(
        event({
          after: {
            readableIds: ['BKT-2026-000014', 'BKT-2026-000015'],
            projectNumber: 'DEMO-2601',
          },
        }),
      ).ref,
    ).toBe('DEMO-2601');
    expect(toActivityItem(event({ after: { readableIds: ['BKT-2026-000014'] } })).ref).toBe(
      'BKT-2026-000014',
    );
    expect(toActivityItem(event({ after: null })).ref).toBeNull();
  });

  it('never exposes raw before/after values', () => {
    const item = toActivityItem(
      event({ before: { secretish: 'old-value' }, after: { unitCount: 2, other: 'x-value' } }),
    );
    expect(item.summary).toBe('AT received 2 storage units');
    expect(JSON.stringify(item)).not.toContain('old-value');
    expect(JSON.stringify(item)).not.toContain('x-value');
  });
});

describe.runIf(testDatabaseUrl)('GET /api/activity/recent and /api/auth/providers', () => {
  let db: TestSchema;
  let app: INestApplication;
  let activeCookie: string;
  let pendingCookie: string;
  let disabledCookie: string;

  async function userWithSession(status: 'active' | 'pending' | 'disabled') {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ('Some One', 'SO', 'personal', $1) RETURNING id`,
      [status],
    );
    const session = await app.get(SessionService).create(rows[0]!.id, 'personal');
    return `${SESSION_COOKIE}=${session.token}`;
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
      }),
    );
    await app.init();
    activeCookie = await userWithSession('active');
    pendingCookie = await userWithSession('pending');
    disabledCookie = await userWithSession('disabled');

    const actor = { userId: null, accountType: 'system' as const, initials: 'AT', name: 'Alex' };
    await withTransaction(db.pool, async (client) => {
      await recordAudit(client, {
        action: 'auth.sign_out',
        entityType: 'session',
        entityId: randomUUID(),
        actor,
      });
      await recordAudit(client, {
        action: 'receipt.confirmed',
        entityType: 'receipt',
        entityId: randomUUID(),
        actor,
        after: { unitCount: 2, projectNumber: 'DEMO-2601' },
      });
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('T2: returns 403 for pending, 401 for disabled and 200 for active users', async () => {
    expect(
      (await request(app.getHttpServer()).get('/api/activity/recent').set('Cookie', pendingCookie))
        .status,
    ).toBe(403);
    expect(
      (await request(app.getHttpServer()).get('/api/activity/recent').set('Cookie', disabledCookie))
        .status,
    ).toBe(401);
    expect(
      (await request(app.getHttpServer()).get('/api/activity/recent').set('Cookie', activeCookie))
        .status,
    ).toBe(200);
  });

  it('T3: only lists dashboard event types', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/activity/recent')
      .set('Cookie', activeCookie);
    const items = activityResponseSchema.parse(response.body);
    expect(items.map((i) => i.action)).toEqual(['receipt.confirmed']);
    expect(items[0]!.summary).toBe('AT received 2 storage units for DEMO-2601');
  });

  it('Field Ledger: hours keeps only recent events', async () => {
    const old = randomUUID();
    await db.pool.query(
      `INSERT INTO audit_event (occurred_at, action, entity_type, entity_id, actor_account_type,
         actor_initials_snapshot, after_values)
       VALUES (now() - interval '3 days', 'receipt.confirmed', 'receipt', $1, 'system', 'OL',
         '{"unitCount": 1}')`,
      [old],
    );
    const recent = activityResponseSchema.parse(
      (
        await request(app.getHttpServer())
          .get('/api/activity/recent?hours=24')
          .set('Cookie', activeCookie)
      ).body,
    );
    expect(recent.some((item) => item.summary.startsWith('OL '))).toBe(false);
    const all = activityResponseSchema.parse(
      (await request(app.getHttpServer()).get('/api/activity/recent').set('Cookie', activeCookie))
        .body,
    );
    expect(all.some((item) => item.summary.startsWith('OL '))).toBe(true);
  });

  it('bounds the limit', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/activity/recent?limit=5000')
      .set('Cookie', activeCookie);
    expect(response.status).toBe(200);
  });

  it('review fix (#109): a location label job that never printed reads as a request', async () => {
    const actor = { userId: null, accountType: 'system' as const, initials: 'AT', name: 'Alex' };
    const undrained = randomUUID();
    const failed = randomUUID();
    const location = { target: 'location', locationId: randomUUID(), locationCode: 'WH-Q1' };
    await withTransaction(db.pool, async (client) => {
      // Queued, and the print worker hasn't taken it.
      await recordAudit(client, {
        action: 'label.print_requested',
        entityType: 'print_job',
        entityId: undrained,
        actor,
        after: location,
      });
      // Queued as a reprint, then refused by the printer.
      await recordAudit(client, {
        action: 'label.reprint_requested',
        entityType: 'print_job',
        entityId: failed,
        actor,
        after: location,
      });
      await recordAudit(client, {
        action: 'label.print_failed',
        entityType: 'print_job',
        entityId: failed,
        actor,
        after: { status: 'failed' },
      });
    });
    const items = activityResponseSchema.parse(
      (await request(app.getHttpServer()).get('/api/activity/recent').set('Cookie', activeCookie))
        .body,
    );
    const jobs = items.filter((item) => item.action.startsWith('label.'));
    // Both were recorded in one transaction (same time), so their order is not compared.
    expect(jobs.map(({ summary, href }) => ({ summary, href }))).toEqual(
      expect.arrayContaining([
        {
          summary: 'AT requested a reprint of the location label for WH-Q1',
          href: '/settings/locations',
        },
        { summary: 'AT requested the location label for WH-Q1', href: '/settings/locations' },
      ]),
    );
    expect(jobs).toHaveLength(2);
    expect(JSON.stringify(jobs)).not.toMatch(/printed/);
  });

  it('reports which sign-in providers exist', async () => {
    const response = await request(app.getHttpServer()).get('/api/auth/providers');
    expect(authProvidersResponseSchema.parse(response.body)).toEqual({
      microsoft: false,
      lab: false,
      test: false,
    });
  });
});
