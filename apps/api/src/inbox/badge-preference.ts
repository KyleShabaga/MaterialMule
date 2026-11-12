import type { Pool, PoolClient } from 'pg';
import { DEFAULT_USER_PREFERENCES, normalizeUserPreferences } from '@materialmule/shared';
import { readSetting } from '../me-settings/person-setting-store.js';

/** The default of the "Count updates in the badge" preference (STRATA-55). */
export const BADGE_UPDATES_DEFAULT = DEFAULT_USER_PREFERENCES.badgeUpdates;

/**
 * Whether unread updates count in this person's Inbox badge (STRATA-55), from their saved
 * preferences (STRATA-29); the default when nothing is saved. Unread requests waiting on them
 * always count.
 */
export async function badgeUpdatesPreference(
  db: Pool | PoolClient,
  userId: string,
): Promise<boolean> {
  const stored = await readSetting(db, userId, 'preferences');
  return stored.value === null
    ? BADGE_UPDATES_DEFAULT
    : normalizeUserPreferences(stored.value).badgeUpdates;
}
