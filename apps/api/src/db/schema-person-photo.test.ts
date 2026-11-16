import { createHash } from 'node:crypto';
import { PERSON_PHOTO_MAX_BYTES } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertUser } from '../test-support/fixtures.js';
import { jpegLikeBytes, tinyPng } from '../test-support/tiny-image.js';

// STRATA-52 (migration 0040): cached directory photos. Each rule proven in the database with
// generated images only (never a real photo).

const REJECT = { code: PG.checkViolation };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe.runIf(testDatabaseUrl)('person photo (0040)', () => {
  let db: TestSchema;

  const insert = (userId: string, contentType: string, bytes: Buffer, sha = digest(bytes)) =>
    db.pool.query(
      `INSERT INTO person_photo (user_id, content_type, bytes, sha256) VALUES ($1, $2, $3, $4)`,
      [userId, contentType, bytes, sha],
    );

  beforeAll(async () => {
    db = await createMigratedSchema();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps one PNG or JPEG per person whose type matches its bytes', async () => {
    const pat = await insertUser(db.pool, 'PX');
    await expect(insert(pat, 'image/png', tinyPng())).resolves.toBeDefined();
    await expect(insert(pat, 'image/png', tinyPng(3))).rejects.toMatchObject({
      code: PG.uniqueViolation,
    });
    const jo = await insertUser(db.pool, 'JX');
    await expect(insert(jo, 'image/jpeg', jpegLikeBytes())).resolves.toBeDefined();
  });

  it('refuses other content types and bytes that are not what the type says', async () => {
    const user = await insertUser(db.pool, 'CT');
    await expect(insert(user, 'image/gif', tinyPng())).rejects.toMatchObject(REJECT);
    await expect(insert(user, 'image/svg+xml', tinyPng())).rejects.toMatchObject(REJECT);
    await expect(insert(user, 'image/jpeg', tinyPng())).rejects.toMatchObject(REJECT);
    await expect(insert(user, 'image/png', jpegLikeBytes())).rejects.toMatchObject(REJECT);
    const html = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await expect(insert(user, 'image/png', html)).rejects.toMatchObject(REJECT);
  });

  it('refuses an empty photo and one over the size limit; the limit itself fits', async () => {
    const user = await insertUser(db.pool, 'SZ');
    await expect(insert(user, 'image/jpeg', Buffer.alloc(0))).rejects.toMatchObject(REJECT);
    await expect(
      insert(user, 'image/jpeg', jpegLikeBytes(PERSON_PHOTO_MAX_BYTES + 1)),
    ).rejects.toMatchObject(REJECT);
    await expect(
      insert(user, 'image/jpeg', jpegLikeBytes(PERSON_PHOTO_MAX_BYTES)),
    ).resolves.toBeDefined();
  });

  it('refuses a digest that is not the SHA-256 of the stored bytes', async () => {
    const user = await insertUser(db.pool, 'SH');
    await expect(insert(user, 'image/png', tinyPng(), digest(tinyPng(4)))).rejects.toMatchObject(
      REJECT,
    );
    await expect(insert(user, 'image/png', tinyPng(), 'ABC')).rejects.toMatchObject(REJECT);
  });

  it('disabling a person deletes their photo, and none can be saved while disabled', async () => {
    const user = await insertUser(db.pool, 'DS');
    await insert(user, 'image/png', tinyPng());
    await db.pool.query(
      `UPDATE app_user SET status = 'disabled', disabled_reason = 'Left the company' WHERE id = $1`,
      [user],
    );
    const { rows } = await db.pool.query('SELECT 1 FROM person_photo WHERE user_id = $1', [user]);
    expect(rows).toHaveLength(0);
    await expect(insert(user, 'image/png', tinyPng())).rejects.toMatchObject(REJECT);
  });

  it('other status changes keep the photo', async () => {
    const user = await insertUser(db.pool, 'KP');
    await insert(user, 'image/png', tinyPng());
    await db.pool.query(`UPDATE app_user SET display_name = 'Pat Example' WHERE id = $1`, [user]);
    const { rows } = await db.pool.query('SELECT 1 FROM person_photo WHERE user_id = $1', [user]);
    expect(rows).toHaveLength(1);
  });
});
