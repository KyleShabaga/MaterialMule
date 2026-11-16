import { formatClockTime, type ReceiptLogItem } from '@materialmule/shared';
import { formatDateTime } from '../lib/format';

/** Confirmation time in the firm's local time, e.g. "2026-01-15 2:05 PM". */
export function formatConfirmedAt(iso: string): string {
  return formatDateTime(iso);
}

/** Time of day in the firm's local time, e.g. "2:05 PM". */
export function formatClock(iso: string): string {
  return formatClockTime(iso);
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
