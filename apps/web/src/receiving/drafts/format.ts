import type { ReceiverOption } from '@materialmule/shared';
import { formatDateTime } from '../../lib/format';
import type { StoredDraft } from './record';

// Text for the draft indicator and the draft list (MM-T11), in the lab's time zone.

const TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "10:42" */
export function formatSavedTime(iso: string): string {
  return TIME.format(new Date(iso));
}

/** "2026-10-26 10:42 AM" */
export function formatSavedDateTime(iso: string): string {
  return formatDateTime(iso);
}

export function receiverText(receiver: Pick<ReceiverOption, 'initials'> | null): string {
  return `Receiver: ${receiver ? receiver.initials : 'not chosen'}`;
}

export function draftTitle(record: StoredDraft): string {
  const project = record.data.project;
  return project ? `${project.projectNumber} · ${project.name}` : 'No project chosen yet';
}
