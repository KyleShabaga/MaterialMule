// STRATA-52 (decision STRATA-53): directory photos for avatars. The server fetches a person's
// Microsoft photo through its Graph integration at sign-in and profile refresh, checks it, and
// caches the bytes on the host, so avatars work offline and the browser never talks to Graph or
// sees a token. Everyone else gets initials (the Material Mule system sender is an MM tile).
//
// Route: GET /api/people/:userId/photo  any active session (LAB included: stations show people's
// avatars). 200 image/jpeg or image/png with a private cache header, or 404 `no_photo` when there
// is none, the person is disabled or pending, or the photo was cleared. Never another format.

/** The largest photo the host keeps; Graph's 96×96 photo is well under this. */
export const PERSON_PHOTO_MAX_BYTES = 100 * 1024;
export const PERSON_PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const;
export type PersonPhotoContentType = (typeof PERSON_PHOTO_CONTENT_TYPES)[number];

/** The same-origin URL of a person's cached photo. A 404 means "use initials". */
export function personPhotoUrl(userId: string): string {
  return `/api/people/${encodeURIComponent(userId)}/photo`;
}

/** Up to two initials from a display name, for the fallback ("Pat Example" → "PE"). */
export function initialsFromName(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]![0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]![0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}
