import type { StorageLocation } from '@materialmule/shared';

// Lab admin › Locations tree (STRATA-102, DESIGN.md › Round 9: settings). Locations have no parent
// in the data model (MM-T37: an optional free-text area groups them), so the tree has two levels:
// a top-level place is an area with the locations in it, or a location that has no area. Paging
// counts top-level places, so a branch is never split across pages.

export const PLACES_PER_PAGE = 10;

export interface AreaPlace {
  kind: 'area';
  /** Stable key for React and the collapse state. */
  key: string;
  area: string;
  locations: StorageLocation[];
  inStock: number;
}

export interface LocationPlace {
  kind: 'location';
  key: string;
  location: StorageLocation;
}

export type TopLevelPlace = AreaPlace | LocationPlace;

/**
 * Top-level places in tree order: the system (Receiving) location first, then areas and
 * stand-alone locations in the order the server lists them (active first, then by name), each
 * area's locations in that same order.
 */
export function buildTree(locations: readonly StorageLocation[]): TopLevelPlace[] {
  const places: TopLevelPlace[] = [];
  const areas = new Map<string, AreaPlace>();
  for (const location of locations) {
    if (location.area === null) {
      places.push({ kind: 'location', key: `location:${location.id}`, location });
      continue;
    }
    let area = areas.get(location.area);
    if (!area) {
      area = {
        kind: 'area',
        key: `area:${location.area}`,
        area: location.area,
        locations: [],
        inStock: 0,
      };
      areas.set(location.area, area);
      places.push(area);
    }
    area.locations.push(location);
    area.inStock += location.inStockCount;
  }
  const system = places.findIndex((place) => place.kind === 'location' && place.location.isSystem);
  if (system > 0) places.unshift(...places.splice(system, 1));
  return places;
}

export function pageCount(places: readonly TopLevelPlace[]): number {
  return Math.max(1, Math.ceil(places.length / PLACES_PER_PAGE));
}

/** A 1-based page number from the URL, clamped to the pages there are. */
export function clampPage(raw: string | null, places: readonly TopLevelPlace[]): number {
  const page = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.min(page, pageCount(places));
}

export function pagePlaces(places: readonly TopLevelPlace[], page: number): TopLevelPlace[] {
  const start = (page - 1) * PLACES_PER_PAGE;
  return places.slice(start, start + PLACES_PER_PAGE);
}

/** The locations a person can see on the page, in row order (a collapsed area hides its own). */
export function visibleLocations(
  places: readonly TopLevelPlace[],
  collapsed: ReadonlySet<string>,
): StorageLocation[] {
  return places.flatMap((place) =>
    place.kind === 'location' ? [place.location] : collapsed.has(place.key) ? [] : place.locations,
  );
}

export function unitsText(count: number): string {
  return count === 1 ? '1 unit' : `${count} units`;
}

export function storageUnitsText(count: number): string {
  return count === 1 ? '1 storage unit' : `${count} storage units`;
}

export function locationsText(count: number): string {
  return count === 1 ? '1 location' : `${count} locations`;
}
