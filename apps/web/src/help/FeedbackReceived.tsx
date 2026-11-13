import { feedbackListSchema, type FeedbackItem } from '@materialmule/shared';
import { CircleAlert, Inbox, RotateCw } from 'lucide-react';
import { Fragment, useEffect, useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '../api/client';
import { feedbackChoiceLabel } from '../feedback/feedback-context';
import { formatExpiry } from '../lib/format';

type Received =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: FeedbackItem[] };

/**
 * Administrators (`feedback.read`, checked by the server too): the latest feedback, newest first,
 * kept on the host as audit events. Unchanged from Field Ledger's Help page apart from its look;
 * it stays on /help until the administrators' Inbox shows feedback.
 */
export function FeedbackReceived() {
  const [received, setReceived] = useState<Received>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const headingId = useId();

  useEffect(() => {
    let active = true;
    void apiFetch('/api/feedback')
      .then(async (response) => {
        if (!response.ok) throw new Error('not ok');
        return feedbackListSchema.parse(await response.json());
      })
      .then(
        (items) => active && setReceived({ state: 'ready', items }),
        () => active && setReceived({ state: 'error' }),
      );
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 id={headingId} className="text-lg font-semibold">
          Feedback received
        </h2>
        {received.state === 'ready' ? (
          <span className="font-mono text-[13px] text-muted-foreground">
            Latest {received.items.length}
          </span>
        ) : null}
      </div>
      {received.state === 'loading' ? (
        <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner role="presentation" aria-hidden="true" aria-label={undefined} />
          Loading feedback…
        </p>
      ) : received.state === 'error' ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Feedback couldn’t load.</AlertTitle>
          <AlertDescription>
            <p>Nothing was changed.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                setReceived({ state: 'loading' });
                setAttempt((a) => a + 1);
              }}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : received.items.length === 0 ? (
        <Empty className="rounded-xl border py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle className="text-sm font-semibold">No feedback yet.</EmptyTitle>
            <EmptyDescription>
              Messages people send from Feedback &amp; bugs appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="divide-y rounded-xl border bg-card">
          {received.items.map((item) => (
            <Fragment key={item.id}>
              <Item size="sm" role="listitem" className="rounded-none">
                <ItemContent className="min-w-0">
                  <ItemTitle className="flex flex-wrap gap-x-3 font-normal">
                    <time className="font-mono text-[13px]" dateTime={item.submittedAt}>
                      {formatExpiry(item.submittedAt)}
                    </time>
                    <span className="font-medium">{item.name ?? 'Someone'}</span>
                    <span className="text-muted-foreground">{feedbackChoiceLabel(item.kind)}</span>
                    {item.page ? (
                      <span className="font-mono text-[13px] text-muted-foreground">
                        {item.page}
                      </span>
                    ) : null}
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none whitespace-pre-wrap text-foreground">
                    {item.text}
                  </ItemDescription>
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </ItemGroup>
      )}
    </section>
  );
}
