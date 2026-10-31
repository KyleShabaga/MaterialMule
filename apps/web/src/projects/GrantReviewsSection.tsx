import {
  GRANT_REVIEW_KIND_LABEL,
  formatPerson,
  type GrantReview,
  type ProjectGrantReviews,
} from '@materialmule/shared';
import { useState } from 'react';
import { BandedCard, StatusBadge } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { ReasonDialog } from './ReasonDialog';
import { decideGrantReview } from './team-api';
import type { RunWrite } from './TeamSections';

// MTR-25 (owner decision 2026-10-30): a new Lead Project Engineer inherits the project's delegate,
// issuer and reviewer grants flagged "Needs review by new lead". The lead or an admin keeps or
// revokes each, with a reason; controls appear only where the server reports `canDecide`.

export const NEEDS_REVIEW = 'Needs review by new lead';

function what(review: GrantReview): string {
  const kind = GRANT_REVIEW_KIND_LABEL[review.kind];
  return `${kind}${review.scope ? `: ${review.scope}` : ''} · ${formatPerson(
    review.holder.initials,
    review.holder.name,
  )}`;
}

export function GrantReviewsSection({
  projectId,
  data,
  run,
  onChange,
}: {
  projectId: string;
  data: ProjectGrantReviews;
  run: RunWrite;
  onChange: (next: ProjectGrantReviews) => void;
}) {
  const [deciding, setDeciding] = useState<{
    review: GrantReview;
    action: 'keep' | 'revoke';
  } | null>(null);
  const [busy, setBusy] = useState(false);
  if (data.pending.length === 0) return null;
  const count = data.pending.length;
  return (
    <BandedCard
      id="grant-reviews"
      className="project-section"
      title="Inherited grants to review"
      tone="attention"
      aside={<StatusBadge tone="warning">{NEEDS_REVIEW}</StatusBadge>}
    >
      <p role="note" className="grant-review-banner">
        This project has a new Lead Project Engineer. {count} grant{count === 1 ? '' : 's'} made
        before the change {count === 1 ? 'needs' : 'need'} review: keep or revoke each one, with a
        reason. They stay in force until then.
      </p>
      <ul className="grant-reviews" aria-label="Grants needing review">
        {data.pending.map((review) => (
          <li key={review.id}>
            <span>
              <strong>{what(review)}</strong>{' '}
              <StatusBadge tone="warning">{NEEDS_REVIEW}</StatusBadge>
              <span className="field-hint">
                {' '}
                Flagged for {formatPerson(
                  review.flaggedFor.initials,
                  review.flaggedFor.name,
                )} on {shortDateTime(review.flaggedAt)}
              </span>
            </span>
            {data.canDecide ? (
              <span className="row-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDeciding({ review, action: 'keep' })}
                  aria-label={`Keep ${what(review)}`}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => setDeciding({ review, action: 'revoke' })}
                  aria-label={`Revoke ${what(review)}`}
                >
                  Revoke
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {data.canDecide ? null : (
        <p className="field-hint">Only the Lead Project Engineer or an admin can review these.</p>
      )}
      <ReasonDialog
        open={deciding !== null}
        title={
          deciding
            ? `${deciding.action === 'keep' ? 'Keep' : 'Revoke'} ${what(deciding.review)}?`
            : ''
        }
        confirmLabel={deciding?.action === 'keep' ? 'Keep' : 'Revoke'}
        danger={deciding?.action === 'revoke'}
        onConfirm={async (text) => {
          const current = deciding;
          setDeciding(null);
          if (!current) return;
          setBusy(true);
          await run(
            decideGrantReview(projectId, current.review.id, current.action, text),
            current.action === 'keep'
              ? `Kept ${what(current.review)}.`
              : `Revoked ${what(current.review)}.`,
            onChange,
          );
          setBusy(false);
        }}
        onCancel={() => setDeciding(null)}
      >
        <p>
          {deciding?.action === 'keep'
            ? 'The grant stays as it is; your reason is kept with the review.'
            : 'The grant ends now. Earlier work keeps their name.'}
        </p>
      </ReasonDialog>
    </BandedCard>
  );
}
