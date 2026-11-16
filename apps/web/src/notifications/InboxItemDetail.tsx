import { inboxAge, type InboxItem, type DateFormatPreference } from '@materialmule/shared';
import { Bell, CircleDot, Mail, X, Undo2 } from 'lucide-react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  REQUEST_ACTION_LABELS,
  REQUEST_CLOSES_WHEN,
  RECORD_KIND_LABELS,
  fromName,
  openRecordLabel,
  recordHref,
  requestState,
  resolvedLine,
  updateSentence,
} from './inbox-model';

// One Inbox item's details (DESIGN.md › Inbox › Drawer): the same body in the drawer and on the
// full page (`/inbox/:key`). Nothing here resolves a request: the main action is a link to where
// the work is done, and the request closes on its own when that work is saved.

export interface InboxItemActions {
  /** Requests only: mark it unread again. */
  onMarkUnread?: () => void;
  /** Updates only: hide it from All and Updates (it moves to Done). */
  onDismiss?: () => void;
  /** Dismissed updates: bring it back. */
  onRestore?: () => void;
  busy?: boolean;
}

/** The circle that tells a request from an update, never by colour alone (icon and fill). */
export function KindIcon({ item, className }: { item: InboxItem; className?: string }) {
  const request = item.type === 'request';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full',
        request ? 'bg-primary text-primary-foreground' : 'border bg-background text-foreground',
        className,
      )}
    >
      {request ? <CircleDot className="size-3" /> : <Bell className="size-3" />}
    </span>
  );
}

/** The filled "Request" pill and the kind; an update shows its kind alone (sr-only "Update"). */
export function KindLabel({ item, className }: { item: InboxItem; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {item.type === 'request' ? (
        <Badge className="h-4 shrink-0 px-1.5 py-0 text-[11px] leading-none">Request</Badge>
      ) : (
        <span className="sr-only">Update: </span>
      )}
      <span className="truncate">{item.task}</span>
    </span>
  );
}

export function InboxItemDetail({
  item,
  titleId,
  now,
  dateFormat,
  actions,
}: {
  item: InboxItem;
  titleId: string;
  now: Date;
  dateFormat?: DateFormatPreference;
  actions: InboxItemActions;
}) {
  const age = inboxAge(item.receivedAt, now, dateFormat);
  const ago = /^\d/.test(age) ? `${age} ago` : age;
  const otherHref = recordHref(item);

  return (
    <article className="flex flex-col gap-5 p-5" data-slot="inbox-item">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <KindIcon item={item} />
          <KindLabel item={item} />
        </div>
        <h2 id={titleId} className="text-lg leading-snug font-semibold text-foreground">
          {item.title}
        </h2>
        <p className="text-sm text-muted-foreground">
          From {fromName(item)} · <time dateTime={item.receivedAt}>{ago}</time>
          {item.type === 'request' && requestState(item) ? <> · {requestState(item)}</> : null}
        </p>
      </header>

      {item.type === 'request' && item.reason ? (
        <p className="text-sm whitespace-pre-line">{item.reason}</p>
      ) : null}
      {item.type === 'update' ? <p className="text-sm">{updateSentence(item)}</p> : null}

      {item.jobNumber || item.record ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
          {item.jobNumber ? (
            <>
              <dt className="text-muted-foreground">Job number</dt>
              <dd className="font-mono">{item.jobNumber}</dd>
            </>
          ) : null}
          {item.record && !(item.record.kind === 'project' && item.jobNumber) ? (
            <>
              <dt className="text-muted-foreground">{RECORD_KIND_LABELS[item.record.kind]}</dt>
              <dd className="min-w-0 truncate font-mono">{item.record.label}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {item.type === 'request' ? (
        <RequestActions item={item} otherHref={otherHref} actions={actions} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to={item.href}>{openRecordLabel(item.record)}</Link>
          </Button>
          {item.dismissed ? (
            actions.onRestore ? (
              <Button variant="outline" onClick={actions.onRestore} disabled={actions.busy}>
                <Undo2 aria-hidden="true" />
                Restore
              </Button>
            ) : null
          ) : actions.onDismiss ? (
            <Button variant="outline" onClick={actions.onDismiss} disabled={actions.busy}>
              <X aria-hidden="true" />
              Dismiss
            </Button>
          ) : null}
        </div>
      )}
    </article>
  );
}

function RequestActions({
  item,
  otherHref,
  actions,
}: {
  item: Extract<InboxItem, { type: 'request' }>;
  otherHref: string | null;
  actions: InboxItemActions;
}) {
  const open = item.status === 'open';
  const mine = open && item.waitingOnMe;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {mine ? (
          <Button asChild>
            <Link to={item.href}>{REQUEST_ACTION_LABELS[item.kind]}</Link>
          </Button>
        ) : null}
        {!mine ? (
          <Button asChild variant={open ? 'default' : 'outline'}>
            <Link to={item.href}>{openRecordLabel(item.record)}</Link>
          </Button>
        ) : otherHref ? (
          <Button asChild variant="outline">
            <Link to={otherHref}>{openRecordLabel(item.record)}</Link>
          </Button>
        ) : null}
        {actions.onMarkUnread && !item.unread ? (
          <Button variant="ghost" onClick={actions.onMarkUnread} disabled={actions.busy}>
            <Mail aria-hidden="true" />
            Mark unread
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {open
          ? `This request closes on its own when ${REQUEST_CLOSES_WHEN[item.kind]}.`
          : resolvedLine(item.resolvedBy, item.resolution)}
      </p>
    </>
  );
}
