import { PERSON_PHOTO_MAX_BYTES } from '@materialmule/shared';
import type { Pool } from 'pg';
import { checkPhoto, clearPersonPhoto, savePersonPhoto } from './person-photo.js';

/** What Graph said about the signed-in person's photo. */
export type GraphPhotoResult =
  | { kind: 'photo'; bytes: Uint8Array }
  /** 404: Microsoft has no photo for them. */
  | { kind: 'none' }
  /** Unreachable, refused, or too large to read: says nothing about the photo. */
  | { kind: 'failed'; status: number | null };

/** Read at most this much; Graph's 96×96 photo is a few KB. */
const READ_LIMIT = PERSON_PHOTO_MAX_BYTES + 1;

async function readCapped(response: Response): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > PERSON_PHOTO_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length >= READ_LIMIT) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Reads the signed-in person's own photo, `GET /v1.0/me/photos/96x96/$value`, with the same
 * delegated `User.Read` token as the profile (User.Read covers the user's own photo; no new
 * consent). Never throws.
 */
export async function fetchGraphPhoto(
  graphBaseUrl: string,
  accessToken: string,
): Promise<GraphPhotoResult> {
  try {
    const response = await fetch(`${graphBaseUrl}/v1.0/me/photos/96x96/$value`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'image/jpeg, image/png' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'none' };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'failed', status: response.status };
    }
    const bytes = await readCapped(response);
    return bytes ? { kind: 'photo', bytes } : { kind: 'failed', status: response.status };
  } catch {
    return { kind: 'failed', status: null };
  }
}

export type PhotoSyncOutcome = 'saved' | 'cleared' | 'kept' | 'rejected';

/**
 * Applies what Graph said to the cache: a checked photo replaces the old one, "no photo" clears
 * it, and a failure (or a photo that isn't JPEG/PNG within the size limit) keeps the last cached
 * one. Never throws: a photo never blocks sign-in or a profile refresh.
 */
export async function applyGraphPhoto(
  pool: Pool,
  userId: string,
  result: GraphPhotoResult,
  warn: (message: string) => void,
): Promise<PhotoSyncOutcome> {
  try {
    if (result.kind === 'none') {
      await clearPersonPhoto(pool, userId);
      return 'cleared';
    }
    if (result.kind === 'failed') {
      warn(`Graph photo read failed (HTTP ${result.status ?? 'none'}); keeping the cached photo`);
      return 'kept';
    }
    const photo = checkPhoto(result.bytes);
    if (!photo) {
      warn('Graph photo is not a JPEG or PNG within the size limit; keeping the cached photo');
      return 'rejected';
    }
    await savePersonPhoto(pool, userId, photo);
    return 'saved';
  } catch (error) {
    warn(`Saving the directory photo failed: ${error instanceof Error ? error.name : 'error'}`);
    return 'kept';
  }
}
