import { createHash } from 'node:crypto';
import { PERSON_PHOTO_MAX_BYTES, type PersonPhotoContentType } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

// STRATA-52: directory photos cached on the host. The server reads a person's Microsoft photo at
// sign-in and profile refresh, checks it here and keeps the bytes in `person_photo`; browsers only
// ever read the cached copy (GET /api/people/:userId/photo), never Graph.

type Db = Pool | PoolClient;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The image type from the bytes themselves (magic numbers), never from a header: JPEG starts
 * FF D8 FF, PNG with its eight-byte signature. Anything else is null.
 */
export function sniffPhotoContentType(bytes: Uint8Array): PersonPhotoContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 && PNG_SIGNATURE.equals(Buffer.from(bytes.subarray(0, 8)))) {
    return 'image/png';
  }
  return null;
}

export interface CheckedPhoto {
  contentType: PersonPhotoContentType;
  bytes: Buffer;
  sha256: string;
}

/** A photo the host may keep, or null: empty, too large, or not JPEG/PNG by its bytes. */
export function checkPhoto(bytes: Uint8Array): CheckedPhoto | null {
  if (bytes.length === 0 || bytes.length > PERSON_PHOTO_MAX_BYTES) return null;
  const contentType = sniffPhotoContentType(bytes);
  if (!contentType) return null;
  const buffer = Buffer.from(bytes);
  return { contentType, bytes: buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

/**
 * Keeps `photo` for `userId`, replacing any earlier one. The database refuses a photo for a
 * disabled person (person_photo_owner_not_disabled), so a disable racing a sign-in never leaves one.
 */
export async function savePersonPhoto(db: Db, userId: string, photo: CheckedPhoto): Promise<void> {
  await db.query(
    `INSERT INTO person_photo (user_id, content_type, bytes, sha256, fetched_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE
       SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes,
           sha256 = EXCLUDED.sha256, fetched_at = EXCLUDED.fetched_at`,
    [userId, photo.contentType, photo.bytes, photo.sha256],
  );
}

/** Forgets a person's photo (Microsoft has none for them now). */
export async function clearPersonPhoto(db: Db, userId: string): Promise<void> {
  await db.query('DELETE FROM person_photo WHERE user_id = $1', [userId]);
}

export interface StoredPhoto {
  contentType: PersonPhotoContentType;
  bytes: Buffer;
  sha256: string;
}

/** The cached photo of an active person, or null (none, pending, disabled or another account type). */
export async function loadActivePersonPhoto(db: Db, userId: string): Promise<StoredPhoto | null> {
  const { rows } = await db.query<{
    content_type: PersonPhotoContentType;
    bytes: Buffer;
    sha256: string;
  }>(
    `SELECT p.content_type, p.bytes, p.sha256
     FROM person_photo p JOIN app_user u ON u.id = p.user_id
     WHERE p.user_id = $1 AND u.status = 'active'`,
    [userId],
  );
  const row = rows[0];
  return row ? { contentType: row.content_type, bytes: row.bytes, sha256: row.sha256 } : null;
}
