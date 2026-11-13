import type { StaffMember, StaffStatus, StaffStatusChange } from '@materialmule/shared';

// Words and dates shared by the Staff table and drawer.

export const STATUS_LABELS: Record<StaffStatus, string> = {
  pending: 'Waiting',
  active: 'Active',
  disabled: 'Disabled',
};
export const STATUS_VARIANTS = { pending: 'due', active: 'storage', disabled: 'closed' } as const;

export const ACCOUNT_LABELS: Record<StaffMember['accountType'], string> = {
  personal: 'Personal',
  shared_lab: 'Shared LAB',
  test: 'Test',
};

const dateTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  dateStyle: 'medium',
  timeStyle: 'short',
});
export const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : 'Never');
export const dateOnly = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  dateStyle: 'medium',
});

const STATUS_CHANGE_LABELS: Record<StaffStatusChange['change'], string> = {
  approved: 'Approved',
  disabled: 'Disabled',
  enabled: 'Re-enabled',
};

/** MTR-12: "Approved by X on date", "Disabled by X on date: reason", "Re-enabled by X on date". */
export function statusChangeText(change: StaffStatusChange): string {
  const by = change.byName ? ` by ${change.byName}` : '';
  const reason = change.reason ? `: ${change.reason}` : '';
  return `${STATUS_CHANGE_LABELS[change.change]}${by} on ${dateOnly.format(new Date(change.at))}${reason}`;
}

/** The latest approval, for the drawer's facts. */
export function approvedChange(member: StaffMember): StaffStatusChange | null {
  return member.statusHistory.findLast((c) => c.change === 'approved') ?? null;
}

/** The latest disable, for the Disabled tab ("2026-10-02 by Sam Sample: Left the lab."). */
export function disabledText(member: StaffMember): string {
  const change = member.statusHistory.findLast((c) => c.change === 'disabled');
  if (!change) return member.disabledReason ?? '—';
  const by = change.byName ? ` by ${change.byName}` : '';
  const reason = change.reason ?? member.disabledReason;
  return `${dateOnly.format(new Date(change.at))}${by}${reason ? `: ${reason}` : ''}`;
}
