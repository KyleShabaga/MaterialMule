import type { ReceiverOption } from '@materialmule/shared';
import type { StoredDraft } from './record';

// Text for the draft indicator and the draft list (MM-T11), in the lab's time zone.

const TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const DATE_TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** "10:42" */
export function formatSavedTime(iso: string): string {
  return TIME.format(new Date(iso));
}

/** "Oct 26, 2026, 10:42 a.m." */
export function formatSavedDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

export function receiverText(receiver: Pick<ReceiverOption, 'initials'> | null): string {
  return `Receiver: ${receiver ? receiver.initials : 'not chosen'}`;
}

export function draftTitle(record: StoredDraft): string {
  const project = record.data.project;
  return project ? `${project.projectNumber} · ${project.name}` : 'No project chosen yet';
}
