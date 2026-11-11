import type { ReceiptLogItem } from '@materialmule/shared';

const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Confirmation time in the firm's local time, e.g. "Jan 15, 2026, 2:05 p.m.". */
export function formatConfirmedAt(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/** "JS · Jordan Smith": initials with the name, so people sharing initials are told apart. */
export function formatReceiver(receiver: ReceiptLogItem['receiver']): string {
  return `${receiver.initials} · ${receiver.name}`;
}

/** The confirming account: "LAB (shared station)" or a person's initials and name. */
export function formatAccount(account: ReceiptLogItem['account']): string {
  if (account.sharedStation) return `${account.name} (shared station)`;
  return account.initials ? `${account.initials} · ${account.name}` : account.name;
}

/**
 * "4 units · TH26-01, TH26-02": a local draft's units count and the test holes named so far.
 * Takes only what it reads, so it never depends on a draft's other fields.
 */
export function draftContents(
  units: readonly { summaries: readonly { testHole: { name: string } }[] }[],
): string {
  const holes = [
    ...new Set(units.flatMap((unit) => unit.summaries.map((summary) => summary.testHole.name))),
  ];
  const count = `${units.length} ${units.length === 1 ? 'unit' : 'units'}`;
  return holes.length > 0 ? `${count} · ${holes.join(', ')}` : count;
}

export function unitCount(quantity: number): string {
  return `${quantity} storage ${quantity === 1 ? 'unit' : 'units'}`;
}
