import {
  GRANT_REVIEW_KIND_LABEL,
  type AccessHistoryEvent,
  type PersonSnapshot,
} from '@materialmule/shared';
import { labDate, shortTime } from '../dashboard/format';

// Wording for Team & permissions (STRATA-85; DESIGN.md › Wording, boards R4Team*): ISO dates in
// the lab's time zone, and each recorded history event as one plain sentence.

/** "2026-11-10" in the lab's time zone. */
export function isoDate(iso: string): string {
  return labDate(new Date(iso));
}

/** "2026-11-10 2:05 p.m." in the lab's time zone. */
export function isoDateTime(iso: string): string {
  return `${isoDate(iso)} ${shortTime(iso)}`;
}

const name = (person: PersonSnapshot | null) => person?.name || 'someone';
const possessive = (person: PersonSnapshot | null) => `${name(person)}’s`;

/** What an event did, after the name of the person who recorded it ("added Pat to the team"). */
export function historyAction(event: AccessHistoryEvent): string {
  const who = name(event.subject);
  const scope = event.scope ? `, ${event.scope}` : '';
  switch (event.kind) {
    case 'team_member_added':
      return `added ${who} to the team`;
    case 'team_member_removed':
      return `removed ${who} from the team`;
    case 'reviewer_assigned':
      return `assigned ${who} as reviewer${scope}`;
    case 'reviewer_removed':
      return `removed ${who} as reviewer${scope}`;
    case 'issuer_granted':
      return `authorized ${who} as report issuer${scope}`;
    case 'issuer_revoked':
      return `ended ${possessive(event.subject)} report issuer grant${scope}`;
    case 'issuer_suspended':
      return `suspended ${possessive(event.subject)} report issuer grant${scope} (emergency)`;
    case 'delegate_granted':
      return `made ${who} an acceptance delegate`;
    case 'delegate_revoked':
      return `ended ${possessive(event.subject)} acceptance delegate grant`;
    case 'lead_appointed':
      return `appointed ${who} as Lead Project Engineer`;
    case 'lead_removed':
      return 'removed the Lead Project Engineer';
    case 'lead_nominated':
      return `nominated ${who} as Lead Project Engineer`;
    case 'nomination_rejected':
      return `rejected the nomination of ${who}`;
    case 'nomination_withdrawn':
      return `withdrew the nomination of ${who}`;
    case 'grant_kept':
    case 'grant_revoked': {
      const kind = event.grantKind
        ? GRANT_REVIEW_KIND_LABEL[event.grantKind].toLowerCase()
        : 'inherited';
      return `${event.kind === 'grant_kept' ? 'kept' : 'ended'} ${possessive(
        event.subject,
      )} inherited ${kind} grant${scope}`;
    }
  }
}

/** The whole sentence, e.g. "Pat Example added Dana Example to the team". */
export function historySentence(event: AccessHistoryEvent): string {
  return `${event.by?.name || 'Someone'} ${historyAction(event)}`;
}
