import { CONCRETE_HOLD_AGE, type ConcreteSpecimenAge } from '@materialmule/shared';
import type { BadgeTone } from '../../components/app-ui';

// Display helpers for the Concrete Lab workspace (MM-V2-C31).

const WORKFLOW_LABEL: Record<string, string> = {
  draft: 'Draft',
  ready_to_submit: 'Ready to submit',
  submitted: 'Submitted',
  returned: 'Returned',
  reviewed: 'Reviewed',
  void: 'Void',
};

/** Where a set's lookup opens (the letter of a specimen ID search is kept). */
export const setLookupPath = (setId: string, letter: string | null = null) =>
  `/concrete/specimens/${encodeURIComponent(setId)}${letter ? `?letter=${letter}` : ''}`;

export const workflowLabel = (state: string) => WORKFLOW_LABEL[state] ?? state;

/** Tag tone for a report's workflow state alone (never merged with the other dimensions). */
const WORKFLOW_TONE: Record<string, BadgeTone> = {
  draft: 'closed',
  ready_to_submit: 'waiting',
  submitted: 'waiting',
  returned: 'danger',
  reviewed: 'storage',
  void: 'danger',
};
export const workflowTone = (state: string): BadgeTone => WORKFLOW_TONE[state] ?? 'closed';

/** A set's readable name: the permanent ID, else the temporary ID, else "Unnumbered set". */
export function setLabel(identity: {
  temporaryId: string | null;
  permanentId: string | null;
}): string {
  return identity.permanentId ?? identity.temporaryId ?? 'Unnumbered set';
}

export const ageLabel = (age: ConcreteSpecimenAge | null) =>
  age === null ? '—' : age === CONCRETE_HOLD_AGE ? 'HOLD' : `${age} d`;

const LAB_DATE_TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** An instant in the lab's time zone, e.g. "Nov 2, 2026, 9:00 a.m.". */
export const labDateTime = (iso: string) => LAB_DATE_TIME.format(new Date(iso));

// ---- Strata round 7 (STRATA-95 part B) --------------------------------------------------------

const LAB_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const LAB_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Edmonton',
  hour: 'numeric',
  minute: '2-digit',
});

/** An instant's lab calendar date, ISO style ("2026-11-04"). */
export const labDate = (iso: string) => LAB_DATE.format(new Date(iso));
/** An instant's lab clock time ("10:20 AM"). */
export const labTime = (iso: string) => LAB_TIME.format(new Date(iso));
/** "2026-11-04 10:20 AM", the Strata date and time in mono cells. */
export const labStamp = (iso: string) => `${labDate(iso)} ${labTime(iso)}`;

/** The age as the round 7 screens write it: "7-day", "HOLD", "—". */
export const ageDays = (age: ConcreteSpecimenAge | null) =>
  age === null ? '—' : age === CONCRETE_HOLD_AGE ? 'HOLD' : `${age}-day`;

/** A set without a casting time (STRATA-120, Kyle 2026-11-12). */
export const UNCAST_NOTE = 'Casting time not recorded';
export const UNCAST_DETAIL = 'No test dates until it is';

/** `datetime-local` value for now, in the browser's time zone, to the minute. */
export function localNow(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`;
}

/** A `datetime-local` value as an ISO instant, or null when it isn't a time. */
export function localToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** "26-31" + "B" → "26-31B": a specimen's ID as it is marked and searched. */
export const specimenName = (set: string, letter: string) => `${set}${letter}`;

/** Where a field report opens (its review view, read-only for lab staff). */
export const fieldReportPath = (reportId: string) =>
  `/concrete/review/${encodeURIComponent(reportId)}`;
