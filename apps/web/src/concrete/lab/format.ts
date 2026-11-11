import { CONCRETE_HOLD_AGE, type ConcreteSpecimenAge } from '@materialmule/shared';
import type { BadgeTone } from '../../components/ui';

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
