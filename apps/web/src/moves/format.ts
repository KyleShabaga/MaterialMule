import type { BadgeTone } from '../components/ui';
import type { QueuedMove } from './store';

// Wording and formats shared by the Move screen and its tests (MM-T28).

/** Local time with its UTC offset, e.g. 2026-10-27T09:15:00.000-06:00. */
export function isoWithOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (n: number, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

/** Status of one batch row in words, the same words as the card's UI states. */
export function moveStatus(
  move: QueuedMove | undefined,
  syncingId: string | null,
): { label: string; tone: BadgeTone } {
  if (!move) return { label: 'Pending', tone: 'info' };
  if (move.clientMoveId === syncingId && move.state === 'pending') {
    return { label: 'Syncing', tone: 'info' };
  }
  switch (move.state) {
    case 'pending':
      return { label: `Pending → ${move.destination.name}`, tone: 'info' };
    case 'waiting':
      return { label: 'Waiting for earlier move', tone: 'warning' };
    case 'saved':
      return { label: 'Saved', tone: 'success' };
    case 'conflict':
      return { label: 'Location conflict', tone: 'danger' };
    case 'attention':
      return { label: 'Needs attention', tone: 'danger' };
    case 'dismissed':
      return { label: 'Dismissed', tone: 'neutral' };
  }
}
