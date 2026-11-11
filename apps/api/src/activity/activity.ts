import type { ActivityItem } from '@materialmule/shared';
import type { AuditEvent } from '../audit/audit.js';

/**
 * Event types shown on the dashboard (MM-T34). Producers (T09 receipts, T13 corrections, T15
 * printing) put the display details below into `after` so summaries never expose raw JSON.
 */
export const DASHBOARD_ACTIONS = [
  'receipt.confirmed',
  'storage_unit.corrected',
  'label.print_requested',
  'label.reprint_requested',
  // Field Ledger Today ledger: moves and disposals, named by the unit's ID (looked up by the
  // controller, since these producers record only the unit's row ID).
  'storage_unit.moved',
  'disposal.removed',
] as const;

/** Display details producers may include in an event's `after` values. */
interface DisplayDetails {
  readableId?: string;
  readableIds?: string[];
  projectNumber?: string;
  unitCount?: number;
  /** MM-T37 location label jobs: `target: 'location'` with the location's code. */
  target?: string;
  locationCode?: string;
  /** storage_unit.moved: where the unit went. */
  locationName?: string;
  confirmedInPlace?: boolean;
}

function details(event: AuditEvent): DisplayDetails {
  const after = (event.after ?? {}) as Record<string, unknown>;
  return {
    readableId: typeof after.readableId === 'string' ? after.readableId : undefined,
    readableIds: Array.isArray(after.readableIds)
      ? after.readableIds.filter((id): id is string => typeof id === 'string')
      : undefined,
    projectNumber: typeof after.projectNumber === 'string' ? after.projectNumber : undefined,
    unitCount: typeof after.unitCount === 'number' ? after.unitCount : undefined,
    target: typeof after.target === 'string' ? after.target : undefined,
    locationCode: typeof after.locationCode === 'string' ? after.locationCode : undefined,
    locationName: locationNameOf(after.location),
    confirmedInPlace: after.confirmedInPlace === true,
  };
}

function locationNameOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const name = (value as Record<string, unknown>).name;
  return typeof name === 'string' ? name : undefined;
}

/** The one record an event is about, as people write it; null when it names several or none. */
function refOf(d: DisplayDetails): string | null {
  const ids = d.readableIds ?? (d.readableId ? [d.readableId] : []);
  if (ids.length === 1) return ids[0]!;
  if (ids.length > 1) return d.projectNumber ?? null;
  return d.projectNumber ?? d.locationCode ?? null;
}

function units(d: DisplayDetails): string {
  const ids = d.readableIds ?? (d.readableId ? [d.readableId] : []);
  if (ids.length === 1) return ids[0]!;
  if (ids.length > 1) return `${ids[0]} and ${ids.length - 1} more`;
  if (d.unitCount !== undefined)
    return `${d.unitCount} storage unit${d.unitCount === 1 ? '' : 's'}`;
  return 'storage units';
}

/**
 * Builds the readable line and link for one audit event. `readableId` is the storage unit's ID
 * when the caller looked it up (moves and disposals record only the unit's row ID).
 */
export function toActivityItem(event: AuditEvent, readableId?: string): ActivityItem {
  const d = details(event);
  if (readableId && !d.readableId && !d.readableIds) d.readableId = readableId;
  const who = event.actorInitials ?? event.actorName ?? 'Someone';
  // At a shared LAB station the account isn't the person: name the receiver as recorded at the
  // time (MM-T56 snapshot), e.g. "LAB for RE received …" (decided 2026-10-27, MM-T61).
  const receiver =
    event.actorAccountType === 'shared_lab'
      ? (event.receiverInitials ?? event.receiverName ?? null)
      : null;
  const forProject = d.projectNumber ? ` for ${d.projectNumber}` : '';
  const forReceiver = receiver ? ` (for ${receiver})` : '';
  let summary: string;
  let href: string | null = null;

  switch (event.action) {
    case 'receipt.confirmed':
      summary = `${receiver ? `${who} for ${receiver}` : who} received ${units(d)}${forProject}`;
      // All statuses, so units of the receipt that were later disposed still show.
      href = event.entityId
        ? `/sample-storage?receiptId=${encodeURIComponent(event.entityId)}&status=all`
        : null;
      break;
    case 'storage_unit.corrected':
      summary = `${who} corrected ${d.readableId ?? 'a storage unit'}`;
      href = d.readableId ? `/sample-storage/${d.readableId}` : null;
      break;
    case 'label.print_requested':
    case 'label.reprint_requested':
      if (d.target === 'location') {
        // MM-T79: a location label names its location and opens Settings → Locations. These
        // events record the request (the job is queued); the printer may not have received it
        // yet, or ever, so the line says what was asked for, not that it printed (review fix,
        // #109). Completion and physical confirmation are separate events, shown on the location.
        const label = `the location label for ${d.locationCode ?? 'a location'}`;
        summary =
          event.action === 'label.reprint_requested'
            ? `${who} requested a reprint of ${label}${forReceiver}`
            : `${who} requested ${label}${forReceiver}`;
        href = '/settings/locations';
        break;
      }
      if (event.action === 'label.print_requested') {
        summary = `${who} printed labels for ${units(d)}${forReceiver}`;
        break;
      }
      summary = `${who} reprinted the label for ${units(d)}${forReceiver}`;
      href = d.readableId ? `/sample-storage/${d.readableId}` : null;
      break;
    case 'storage_unit.moved':
      summary = d.confirmedInPlace
        ? `${who} confirmed ${d.readableId ?? 'a storage unit'} at ${d.locationName ?? 'its location'}`
        : `${who} moved ${d.readableId ?? 'a storage unit'} to ${d.locationName ?? 'a new location'}`;
      href = d.readableId ? `/sample-storage/${d.readableId}` : null;
      break;
    case 'disposal.removed':
      summary = `${who} recorded the disposal of ${d.readableId ?? 'a storage unit'}`;
      href = d.readableId ? `/sample-storage/${d.readableId}` : null;
      break;
    default:
      summary = `${who}: ${event.action}`;
  }

  return {
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    action: event.action,
    actorInitials: event.actorInitials,
    actorName: event.actorName,
    summary,
    ref: refOf(d),
    href,
  };
}
