import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../db/transaction.js';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { insertUser } from '../test-support/fixtures.js';
import { listAuditForEntity, listRecentAudit, recordAudit, type AuditActor } from './audit.js';

describe.runIf(testDatabaseUrl)('audit events', () => {
  let db: TestSchema;
  let actor: AuditActor;

  beforeAll(async () => {
    db = await createMigratedSchema();
    const userId = await insertUser(db.pool, 'JS');
    actor = { userId, accountType: 'test', initials: 'JS', name: 'Jordan Smith' };
  });

  afterAll(async () => {
    await db?.drop();
  });

  const record = (entityId: string, action = 'storage_unit.corrected') =>
    withTransaction(db.pool, (client) =>
      recordAudit(client, {
        action,
        entityType: 'storage_unit',
        entityId,
        actor,
        reason: 'wrong date on tag',
        before: { receivedDate: '2026-10-23' },
        after: { receivedDate: '2026-10-21' },
        requestId: 'req-12345678',
      }),
    );

  it('records every field and reads history newest first', async () => {
    const entityId = randomUUID();
    await record(entityId, 'storage_unit.created');
    await record(entityId, 'storage_unit.corrected');

    const history = await listAuditForEntity(db.pool, 'storage_unit', entityId);
    expect(history.map((e) => e.action)).toEqual([
      'storage_unit.corrected',
      'storage_unit.created',
    ]);
    expect(history[0]).toMatchObject({
      actorInitials: 'JS',
      actorName: 'Jordan Smith',
      actorAccountType: 'test',
      reason: 'wrong date on tag',
      before: { receivedDate: '2026-10-23' },
      after: { receivedDate: '2026-10-21' },
      requestId: 'req-12345678',
    });
  });

  it('rolls back with the change it describes', async () => {
    const entityId = randomUUID();
    await expect(
      withTransaction(db.pool, async (client) => {
        await recordAudit(client, {
          action: 'receipt.confirmed',
          entityType: 'receipt',
          entityId,
          actor,
        });
        throw new Error('receipt failed');
      }),
    ).rejects.toThrowError('receipt failed');
    expect(await listAuditForEntity(db.pool, 'receipt', entityId)).toEqual([]);
  });

  it('AC6: rejects UPDATE, DELETE and TRUNCATE', async () => {
    const entityId = randomUUID();
    const id = await record(entityId);
    await expect(
      db.pool.query(`UPDATE audit_event SET reason = 'rewritten' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.pool.query('DELETE FROM audit_event WHERE id = $1', [id]),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(db.pool.query('TRUNCATE audit_event')).rejects.toMatchObject({ code: '42501' });
    expect(await listAuditForEntity(db.pool, 'storage_unit', entityId)).toHaveLength(1);
  });

  it('AC7: renaming or disabling the user never rewrites past attribution', async () => {
    const entityId = randomUUID();
    await record(entityId);
    await db.pool.query(
      `UPDATE app_user SET display_name = 'Jordan Smith-Lee', official_initials = 'JSL',
                           status = 'disabled'
       WHERE id = $1`,
      [actor.userId],
    );
    const [event] = await listAuditForEntity(db.pool, 'storage_unit', entityId);
    expect(event).toMatchObject({ actorInitials: 'JS', actorName: 'Jordan Smith' });
  });

  it('rejects malformed action names', async () => {
    await expect(record(randomUUID(), 'Corrected')).rejects.toBeInstanceOf(TypeError);
  });

  it('lists recent events filtered by action', async () => {
    const entityId = randomUUID();
    await record(entityId, 'receipt.confirmed');
    const recent = await listRecentAudit(db.pool, ['receipt.confirmed'], 5);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.every((e) => e.action === 'receipt.confirmed')).toBe(true);
  });

  it('pages history with a bounded limit', async () => {
    const entityId = randomUUID();
    for (let i = 0; i < 3; i++) {
      await record(entityId);
    }
    expect(await listAuditForEntity(db.pool, 'storage_unit', entityId, { limit: 2 })).toHaveLength(
      2,
    );
    expect(
      await listAuditForEntity(db.pool, 'storage_unit', entityId, { limit: 2, offset: 2 }),
    ).toHaveLength(1);
  });
});
