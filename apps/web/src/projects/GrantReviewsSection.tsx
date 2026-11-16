import {
  GRANT_REVIEW_KIND_LABEL,
  type GrantReview,
  type ProjectGrantReviews,
  type ProjectTeamJoinRequests,
} from '@materialmule/shared';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { PersonAvatar } from '@/components/strata/person-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { JoinRequestItem } from './JoinRequestsSection';
import { ReasonForm } from './ReasonDialog';
import { TeamCard } from './TeamCard';
import { decideGrantReview } from './team-api';
import { isoDate } from './team-format';
import type { RunWrite } from './TeamSections';

// Team & permissions › Needs review (STRATA-85; board R4Team): MISC-07 join requests and the
// MTR-25 grants a new Lead Project Engineer inherited (owner decision 2026-10-30: flagged "Needs
// review by new lead", in force until the lead or an admin keeps or ends each, with a reason).
// Shown only to the people the server lets decide (`canDecide`).

export const NEEDS_REVIEW = 'Needs review by new lead';

/** "Report issuer: Concrete field · Taylor Sample": names a flagged grant in labels. */
function what(review: GrantReview): string {
  return `${GRANT_REVIEW_KIND_LABEL[review.kind]}${review.scope ? `: ${review.scope}` : ''} · ${
    review.holder.name
  }`;
}

function GrantReviewItem({
  projectId,
  review,
  run,
  onChange,
}: {
  projectId: string;
  review: GrantReview;
  run: RunWrite;
  onChange: (next: ProjectGrantReviews) => void;
}) {
  const [deciding, setDeciding] = useState<'keep' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = GRANT_REVIEW_KIND_LABEL[review.kind];
  const label = what(review);
  return (
    <Item role="listitem" size="sm" className="px-0">
      <ItemMedia>
        <PersonAvatar name={review.holder.name} userId={review.holder.userId} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex-wrap">
          {review.holder.name}{' '}
          <span className="font-normal text-muted-foreground">
            holds {kind.toLowerCase()} grant made before the lead changed
          </span>
          <Badge variant="due">{NEEDS_REVIEW}</Badge>
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {kind}
          {review.scope ? ` · ${review.scope}` : ''} · flagged for {review.flaggedFor.name} · keep
          it or end it · <span className="font-mono">{isoDate(review.flaggedAt)}</span>
        </ItemDescription>
      </ItemContent>
      {deciding === null ? (
        <ItemActions>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-label={`End ${label}`}
            onClick={() => setDeciding('revoke')}
          >
            End grant
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-label={`Keep ${label}`}
            onClick={() => setDeciding('keep')}
          >
            <Check aria-hidden="true" />
            Keep
          </Button>
        </ItemActions>
      ) : (
        <ReasonForm
          title={`${deciding === 'keep' ? 'Keep' : 'End'} ${label}?`}
          confirmLabel={deciding === 'keep' ? 'Keep grant' : 'End grant'}
          busy={busy}
          onCancel={() => setDeciding(null)}
          onConfirm={async (reason) => {
            const action = deciding;
            setBusy(true);
            const ok = await run(
              decideGrantReview(projectId, review.id, action, reason),
              action === 'keep' ? `Kept ${label}.` : `Ended ${label}.`,
              onChange,
            );
            setBusy(false);
            if (ok) setDeciding(null);
          }}
        >
          {deciding === 'keep'
            ? 'The grant stays as it is; your reason is kept with the review.'
            : 'The grant ends now. Earlier work keeps their name.'}
        </ReasonForm>
      )}
    </Item>
  );
}

/** How many items wait for this viewer's decision (0 when they may decide none). */
// eslint-disable-next-line react-refresh/only-export-components -- count beside its section
export function needsReviewCount(
  joinRequests: ProjectTeamJoinRequests | null,
  grantReviews: ProjectGrantReviews | null,
): number {
  return (
    (joinRequests?.canDecide ? joinRequests.pending.length : 0) +
    (grantReviews?.canDecide ? grantReviews.pending.length : 0)
  );
}

export function NeedsReviewSection({
  projectId,
  joinRequests,
  grantReviews,
  run,
  onJoinChange,
  onReviewChange,
}: {
  projectId: string;
  joinRequests: ProjectTeamJoinRequests | null;
  grantReviews: ProjectGrantReviews | null;
  run: RunWrite;
  onJoinChange: (next: ProjectTeamJoinRequests) => void;
  onReviewChange: (next: ProjectGrantReviews) => void;
}) {
  const count = needsReviewCount(joinRequests, grantReviews);
  if (count === 0) return null;
  const joins = joinRequests?.canDecide ? joinRequests.pending : [];
  const reviews = grantReviews?.canDecide ? grantReviews.pending : [];
  return (
    <TeamCard id="team-review" title="Needs review" count={count}>
      {joins.length > 0 ? (
        <ItemGroup aria-label="Join requests">
          {joins.map((request) => (
            <JoinRequestItem
              key={request.id}
              projectId={projectId}
              request={request}
              run={run}
              onChange={onJoinChange}
            />
          ))}
        </ItemGroup>
      ) : null}
      {reviews.length > 0 ? (
        // MTR-25's region and list names, kept from the earlier Team & Permissions page.
        <section aria-label="Inherited grants to review" className="flex flex-col gap-2">
          <p role="note" className="text-sm">
            This project has a new Lead Project Engineer. {reviews.length} grant
            {reviews.length === 1 ? '' : 's'} made before the change{' '}
            {reviews.length === 1 ? 'needs' : 'need'} review. They stay in force until then.
          </p>
          <ItemGroup aria-label="Grants needing review">
            {reviews.map((review) => (
              <GrantReviewItem
                key={review.id}
                projectId={projectId}
                review={review}
                run={run}
                onChange={onReviewChange}
              />
            ))}
          </ItemGroup>
        </section>
      ) : null}
      <p className="text-[13px] text-muted-foreground">
        Only the lead and admins see this. Declining, keeping or ending a grant needs a reason;
        accepting doesn’t.
      </p>
    </TeamCard>
  );
}
