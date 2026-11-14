import type {
  ConcreteFieldReportSummary,
  ConcreteMixPropagationItem,
  ConcreteMixStatus,
  ConcreteProjectSetStatus,
  StageKey,
} from '@materialmule/shared';

// STRATA-98: words and stage colours for the project's Concrete tab (DESIGN.md › Lifecycle and
// the round 8 boards R8Project*, R8Mix*). Stage colours mean stage only: draft, waiting on someone
// (due), act now (danger), at rest (storage), done (closed).

/** A field report's status tag, as the round 8 Field reports board writes it. */
export function reportStatus(
  report: Pick<ConcreteFieldReportSummary, 'workflowState' | 'issueCount' | 'version'>,
): {
  stage: StageKey;
  label: string;
} {
  if (report.issueCount > 0) {
    return {
      stage: 'closed',
      label: report.issueCount > 1 ? 'Issued · Revised' : 'Issued',
    };
  }
  switch (report.workflowState) {
    case 'draft':
      return { stage: 'draft', label: 'Draft' };
    case 'ready_to_submit':
      return { stage: 'draft', label: 'Ready to submit' };
    case 'submitted':
      return {
        stage: 'due',
        label: report.version > 1 ? `Submitted · v${report.version}` : 'Submitted',
      };
    case 'returned':
      return { stage: 'danger', label: 'Returned for correction' };
    case 'reviewed':
      return { stage: 'due', label: 'Awaiting issuance' };
    case 'void':
      return { stage: 'closed', label: 'Void' };
    default:
      return { stage: 'closed', label: report.workflowState };
  }
}

/** The review column: where the report stands in review. */
export function reportReview(
  report: Pick<ConcreteFieldReportSummary, 'workflowState' | 'issueCount' | 'lastIssuedAt'>,
): string {
  if (report.issueCount > 0) {
    const day = report.lastIssuedAt?.slice(0, 10);
    return day ? `Issued ${day}` : 'Issued';
  }
  switch (report.workflowState) {
    case 'draft':
    case 'ready_to_submit':
      return 'Not submitted';
    case 'submitted':
      return 'Waiting for review';
    case 'returned':
      return 'Returned to the technician';
    case 'reviewed':
      return 'Reviewed';
    default:
      return '—';
  }
}

/** The Field reports filters (one status at a time, plus Mine). */
export const REPORT_STATUS_FILTERS = [
  { id: 'draft', label: 'Draft' },
  { id: 'submitted', label: 'Submitted' },
  { id: 'returned', label: 'Returned' },
  { id: 'reviewed', label: 'Reviewed' },
  { id: 'issued', label: 'Issued' },
] as const;

/** One status at a time (the server filters on one), plus Mine. The newest status wins. */
export function keepOneStatus(filters: string[]): string[] {
  const ids = new Set<string>(REPORT_STATUS_FILTERS.map((f) => f.id));
  const statuses = filters.filter((id) => ids.has(id));
  const last = statuses[statuses.length - 1];
  return filters.filter((id) => !ids.has(id) || id === last);
}

/** The report list's server query for a status filter id. */
export function reportStatusQuery(status: string | null): { state?: string; issued?: string } {
  if (status === 'issued') return { issued: 'true' };
  if (status === 'reviewed') return { state: 'reviewed', issued: 'false' };
  return status ? { state: status } : {};
}

export const SET_STAGE: Record<ConcreteProjectSetStatus, StageKey> = {
  no_casting_time: 'due',
  curing: 'storage',
  due_today: 'lab',
  overdue: 'danger',
  on_hold: 'storage',
  tested: 'closed',
  void: 'closed',
};

export const MIX_STAGE: Record<ConcreteMixStatus, { stage: StageKey; label: string }> = {
  unapproved: { stage: 'draft', label: 'Unapproved' },
  approved: { stage: 'storage', label: 'Approved' },
  revision_pending: { stage: 'due', label: 'Revision pending' },
};

/** A test age as the Sets list writes it: days, or HOLD. */
export const ageText = (age: number | 'HOLD' | null) =>
  age === null ? '—' : age === 'HOLD' ? 'HOLD' : String(age);

/** A short date-time for history lines: "2026-11-11 9:30 AM". */
export function dateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
  const time = date.toLocaleTimeString('en-US', {
    timeZone: 'America/Edmonton',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${day} ${time}`;
}

export type PropagationGroup = 'can' | 'call' | 'wont';

/** Which group an item is listed in: the server says what's eligible; a kept value makes it the Lead's call. */
export function propagationGroup(item: ConcreteMixPropagationItem): PropagationGroup {
  if (!item.eligible) return 'wont';
  return item.kept.length > 0 ? 'call' : 'can';
}
