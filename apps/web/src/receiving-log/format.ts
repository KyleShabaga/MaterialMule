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

const clockFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  hour: 'numeric',
  minute: '2-digit',
});

/** Time of day in the firm's local time, e.g. "2:05 p.m.". */
export function formatClock(iso: string): string {
  return clockFormat.format(new Date(iso));
}

/** "JS · Jordan Smith": initials with the name, so people sharing initials are told apart. */
export function formatReceiver(receiver: ReceiptLogItem['receiver']): string {
  return `${receiver.initials} · ${receiver.name}`;
}

export function unitCount(quantity: number): string {
  return `${quantity} storage ${quantity === 1 ? 'unit' : 'units'}`;
}

/** A receipt's name (receipts have no number): "2026-10-21 · Alex Tester". */
export function receiptName(receipt: Pick<ReceiptLogItem, 'receivedDate' | 'receiver'>): string {
  return `${receipt.receivedDate} · ${receipt.receiver.name}`;
}
