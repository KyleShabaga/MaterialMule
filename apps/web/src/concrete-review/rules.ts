import type {
  ConcreteChecklistItem,
  ConcreteFieldReportDetail,
  MeResponse,
  PersonSnapshot,
  ProjectReportIssuers,
} from '@materialmule/shared';

// MM-V2-C28: why an action is unavailable and who can take it. The screen disables the button and
// shows the sentence; the server checks everything again on every command.

export const names = (people: readonly PersonSnapshot[]) =>
  people.length === 0 ? '' : people.map((p) => p.name).join(', ');

/** Who may review (or return) the latest version: its routed reviewer, or the reviewers and lead. */
export function whoCanReview(detail: ConcreteFieldReportDetail): string {
  const lead = detail.reviewRouting.leadProjectEngineer;
  const leadText = lead ? `the Lead Project Engineer (${lead.name})` : 'the Lead Project Engineer';
  const route = detail.lifecycle.latestVersion?.route;
  if (route && route.kind !== 'designated_reviewers' && route.routedTo) {
    return `${route.routedTo.name} (routed to them) or ${leadText}`;
  }
  const reviewers = detail.reviewRouting.designatedReviewers.filter(
    (p) => p.userId !== lead?.userId,
  );
  if (reviewers.length === 0) return leadText;
  return `a designated reviewer (${names(reviewers)}) or ${leadText}`;
}

/** Who may issue: the lead and the project's Authorized report issuers for field reports. */
export function whoCanIssue(
  detail: ConcreteFieldReportDetail,
  issuers: ProjectReportIssuers | null,
): string {
  const lead = detail.reviewRouting.leadProjectEngineer;
  const leadText = lead ? `the Lead Project Engineer (${lead.name})` : 'the Lead Project Engineer';
  const active = (issuers?.active ?? []).filter(
    (g) => g.effective && g.scope.code === 'concrete_field',
  );
  if (active.length > 0) {
    return `${leadText} or an Authorized report issuer (${names(active.map((g) => g.issuer))})`;
  }
  return `${leadText} or an Authorized report issuer for field reports`;
}

type Common = { me: MeResponse; detail: ConcreteFieldReportDetail };

function personalAndNotOwn({ me, detail }: Common, verb: string): string | null {
  if (me.accountType === 'shared_lab') {
    return `The shared LAB account can’t ${verb} reports. Sign in with your own account.`;
  }
  if (detail.technician?.userId === me.id) {
    return `You are this report’s technician. Someone else must ${verb} it.`;
  }
  return null;
}

/** Why Mark reviewed is unavailable now, or null when it can be sent (AC1). */
export function markReviewedBlock(
  input: Common & { open: readonly ConcreteChecklistItem[] },
): string | null {
  const { detail, open } = input;
  if (detail.lifecycle.state !== 'submitted') return 'This report isn’t awaiting review.';
  const account = personalAndNotOwn(input, 'review');
  if (account) return account;
  if (!detail.lifecycle.allowedActions.includes('review')) {
    return `Only ${whoCanReview(detail)} can review this report.`;
  }
  if (open.length > 0) {
    return `${open.length} ${open.length === 1 ? 'exception is' : 'exceptions are'} still open. Resolve or document each one first.`;
  }
  return null;
}

/** Why Return for correction is unavailable now, or null. */
export function returnBlock(input: Common): string | null {
  const { detail } = input;
  if (detail.lifecycle.state !== 'submitted' && detail.lifecycle.state !== 'reviewed') {
    return 'Only a report awaiting review or issuance can be returned.';
  }
  const account = personalAndNotOwn(input, 'review');
  if (account) return account;
  if (!detail.lifecycle.allowedActions.includes('return')) {
    return `Only ${whoCanReview(detail)} can return this report.`;
  }
  return null;
}

/** Why documenting an exception is unavailable now, or null. */
export function documentBlock(input: Common): string | null {
  if (input.detail.lifecycle.state !== 'submitted') return 'Only a version awaiting review.';
  const account = personalAndNotOwn(input, 'review');
  if (account) return account;
  // Documenting is review work: the same people as Mark reviewed.
  if (!input.detail.lifecycle.allowedActions.includes('review')) {
    return `Only ${whoCanReview(input.detail)} can document exceptions.`;
  }
  return null;
}

/** Why Issue report is unavailable now, or null. */
export function issueBlock(
  input: Common & { issuers: ProjectReportIssuers | null; machineChoice: boolean | null },
): string | null {
  const { detail } = input;
  if (detail.lifecycle.state !== 'reviewed') return 'Only a reviewed report can be issued.';
  const account = personalAndNotOwn(input, 'issue');
  if (account) return account;
  if (!detail.lifecycle.allowedActions.includes('issue')) {
    return `Only ${whoCanIssue(detail, input.issuers)} can issue this report.`;
  }
  if (input.machineChoice === null) {
    return 'Choose whether to include the testing machine information.';
  }
  return null;
}
