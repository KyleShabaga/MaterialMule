import type { WriteResult } from './api';

/** Plain-language text for a refused review or lifecycle action (MM-T25, MM-T26). */
export function problemText(result: Exclude<WriteResult<unknown>, { ok: true }>): string {
  if (result.kind === 'conflict') {
    if (result.code === 'version_conflict') {
      return 'Someone else updated this test first. It has been refreshed; check it and try again.';
    }
    if (result.code === 'correction_superseded') {
      return 'This correction was already dealt with. The test has been refreshed.';
    }
    if (result.code === 'already_requested') {
      return 'Someone has already asked for this. It has been refreshed.';
    }
    return 'This changed elsewhere. The test has been refreshed.';
  }
  if (result.kind === 'invalid') {
    return result.errors.map((error) => error.message).join(' ') || 'Check the details.';
  }
  if (result.kind === 'forbidden') return 'You can’t do this from this account.';
  if (result.kind === 'unauthenticated') return 'Your session has ended. Sign in again.';
  if (result.kind === 'network') return 'Couldn’t reach Material Mule. Try again.';
  return 'Something went wrong. Try again.';
}
