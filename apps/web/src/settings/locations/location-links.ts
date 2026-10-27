import type { StorageLocation } from '@materialmule/shared';

// Settings → Locations (MM-T37) helpers shared by the page and the drawer.

export const MANAGE_PERMISSION = 'location.manage';
export const NOT_ALLOWED_TEXT = 'Only Lab Managers and administrators can add or change locations.';

/** Inventory filtered to the location's current stock (the same units that block retirement). */
export function inventoryLink(location: Pick<StorageLocation, 'id'>): string {
  return `/sample-storage?locationId=${encodeURIComponent(location.id)}`;
}
