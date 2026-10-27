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
] as const;

/** Display details producers may include in an event's `after` values. */
interface DisplayDetails {
  readableId?: string;
  readableIds?: string[];
  projectNumber?: string;
  unitCount?: number;
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
  };
}

function units(d: DisplayDetails): string {
  const ids = d.readableIds ?? (d.readableId ? [d.readableId] : []);
  if (ids.length === 1) return ids[0]!;
  if (ids.length > 1) return `${ids[0]} and ${ids.length - 1} more`;
  if (d.unitCount !== undefined)
    return `${d.unitCount} storage unit${d.unitCount === 1 ? '' : 's'}`;
  return 'storage units';
}

/** Builds the readable line and link for one audit event. */
export function toActivityItem(event: AuditEvent): ActivityItem {
  const d = details(event);
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
      summary = `${who} printed labels for ${units(d)}${forReceiver}`;
      break;
    case 'label.reprint_requested':
      summary = `${who} reprinted the label for ${units(d)}${forReceiver}`;
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
    href,
  };
}
