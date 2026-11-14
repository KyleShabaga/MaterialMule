import {
  ArrowDownToLine,
  ArrowRightLeft,
  Check,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  FlaskConical,
  Folder,
  FolderPlus,
  Hammer,
  Hourglass,
  Printer,
  RotateCw,
  ScanLine,
  SquareKanban,
  type LucideIcon,
} from 'lucide-react';
import {
  DEFAULT_DATE_FORMAT,
  NEEDS_YOU_FIRST,
  needsYouSummary,
  STAGE_WORDS,
  type DateFormatPreference,
  type MeResponse,
  type NeedsYouItem,
  type NeedsYouResponse,
} from '@materialmule/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { STAGE_MARK_BG } from '@/components/strata/stage';
import { StageTag } from '@/components/strata/stage-tag';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { FEATURES } from '../features';
import { useMe } from '../session/context';
import { useRecordingPerson } from '../session/recording-person';
import { fetchActivity, fetchDateFormat, fetchLeadsAnyProject, fetchNeedsYou } from './api';
import { StationSetupCard } from './station/StationSetupCard';
import { StationToday } from './station/StationToday';
import {
  ACTIVITY_SCOPE_BY_ROLE,
  CLEAR_HINT_BY_ROLE,
  firstName,
  greetingText,
  monoParts,
  shortcutsFor,
  splitActivity,
  todayRole,
  unavailableNote,
  visibleNeeds,
  welcomeDate,
  type ActivityLine,
  type ShortcutIcon,
  type TodayRole,
} from './today';
import { useLoad, type LoadState } from './useLoad';

// Today (Strata; DESIGN.md "Today with an own account", "Today for the Lab Manager", "Today for a
// technician"; canvases TodayLeadContent, TodayManagerContent, TodayTechContent). A LAB station
// gets the station's own Today. Needs you and the last 24 hours load independently, so one
// failing leaves the other and the shortcuts working. The Inbox badge never comes from here.

/** The Inbox page Needs you's heading links to. */
export const INBOX_PATH = '/inbox';

const SHORTCUT_ICONS: Record<ShortcutIcon, LucideIcon> = {
  'flask-conical': FlaskConical,
  'clipboard-check': ClipboardCheck,
  folder: Folder,
  'folder-plus': FolderPlus,
  'square-kanban': SquareKanban,
  hammer: Hammer,
  hourglass: Hourglass,
  'scan-line': ScanLine,
  'arrow-down-to-line': ArrowDownToLine,
  'arrow-right-left': ArrowRightLeft,
  printer: Printer,
};

/** Never settles: a load that waits for something else first. */
const WAITING = new Promise<never>(() => undefined);

function MonoText({ text, ids }: { text: string; ids?: readonly string[] }) {
  return (
    <>
      {monoParts(text, ids).map((part, i) =>
        part.mono ? (
          <span key={i} className="font-mono text-[13px] whitespace-nowrap">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** Which Today this account gets; null while it is being worked out (one projects call). */
function useTodayRole(me: MeResponse): TodayRole | null {
  const manager = me.roles.includes('lab_manager');
  const canList = me.permissions.includes('inventory.read');
  const [leads, setLeads] = useState<boolean | null>(null);
  const asks = !manager && canList;
  useEffect(() => {
    if (!asks) return;
    let active = true;
    void fetchLeadsAnyProject().then((value) => {
      if (active) setLeads(value);
    });
    return () => {
      active = false;
    };
  }, [asks]);
  if (!asks) return todayRole(me, false);
  return leads === null ? null : todayRole(me, leads);
}

function useDateFormat(): DateFormatPreference {
  const [format, setFormat] = useState<DateFormatPreference>(DEFAULT_DATE_FORMAT);
  useEffect(() => {
    let active = true;
    void fetchDateFormat().then((value) => {
      if (active) setFormat(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return format;
}

function Welcome({
  me,
  now,
  needs,
}: {
  me: MeResponse;
  now: Date;
  needs: LoadState<NeedsYouResponse>;
}) {
  const dateFormat = useDateFormat();
  return (
    <div className="grid gap-1">
      <p className="text-sm text-muted-foreground">{welcomeDate(now, dateFormat)}</p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {greetingText(firstName(me.displayName), now)}
      </h1>
      {needs.state === 'ready' ? (
        <p className="text-base text-muted-foreground">
          {needsYouSummary(needs.data.total, needs.data.fromInbox)}
        </p>
      ) : needs.state === 'loading' ? (
        <Skeleton className="h-6 w-64" aria-hidden="true" />
      ) : null}
    </div>
  );
}

function Shortcuts({ role, me }: { role: TodayRole | null; me: MeResponse }) {
  if (!role) return <Skeleton className="h-11 w-full max-w-xl" aria-hidden="true" />;
  const shortcuts = shortcutsFor(role, me, FEATURES);
  if (shortcuts.length === 0) return null;
  return (
    <nav aria-label="Shortcuts" className="flex flex-wrap gap-2">
      {shortcuts.map((shortcut) => {
        const Icon = SHORTCUT_ICONS[shortcut.icon];
        return (
          <Button
            key={shortcut.label}
            asChild
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
          >
            <Link to={shortcut.to}>
              <Icon aria-hidden="true" />
              {shortcut.label}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
}

function NeedsRow({ item, primary }: { item: NeedsYouItem; primary: boolean }) {
  return (
    <li className="relative flex flex-wrap items-center gap-x-4 gap-y-2 p-4 pl-5">
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-2.5 bottom-2.5 left-1 w-1 rounded-full',
          STAGE_MARK_BG[item.stage],
        )}
      />
      <div className="grid min-w-0 flex-1 basis-64 gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {item.source === 'request' ? (
            <>
              <Badge className="px-2 text-[11px] font-semibold">Request</Badge>
              <StageTag stage={item.stage} label={`${STAGE_WORDS[item.stage]} · ${item.task}`} />
            </>
          ) : (
            <StageTag stage={item.stage} domain={item.domain} />
          )}
        </div>
        <p className="font-medium">{item.title}</p>
        {item.detail ? (
          <p className="text-sm text-muted-foreground">
            <MonoText text={item.detail} ids={item.ids} />
          </p>
        ) : null}
      </div>
      <Button
        asChild
        size="sm"
        variant={primary ? 'default' : 'outline'}
        className="pointer-coarse:h-11"
      >
        <Link to={item.href}>
          {item.action}
          <span className="sr-only">: {item.title}</span>
        </Link>
      </Button>
    </li>
  );
}

function NeedsYou({
  needs,
  retry,
  role,
}: {
  needs: LoadState<NeedsYouResponse>;
  retry: () => void;
  role: TodayRole | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const focusAfterExpand = useRef(false);
  useEffect(() => {
    if (!expanded || !focusAfterExpand.current) return;
    focusAfterExpand.current = false;
    // The first row that just appeared takes focus, so the keyboard carries on where it was.
    list.current?.querySelectorAll('li')[NEEDS_YOU_FIRST]?.querySelector('a')?.focus();
  }, [expanded]);

  let body;
  if (needs.state === 'loading') {
    body = (
      <div className="grid gap-2" aria-busy="true">
        <span className="sr-only">Checking what needs you…</span>
        <Skeleton className="h-24 w-full" aria-hidden="true" />
        <Skeleton className="h-24 w-full" aria-hidden="true" />
      </div>
    );
  } else if (needs.state === 'error') {
    body = (
      <>
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle className="line-clamp-none">Needs you couldn’t load.</AlertTitle>
          <AlertDescription>Shortcuts and the last 24 hours still work.</AlertDescription>
        </Alert>
        <Button
          variant="outline"
          className="self-start pointer-coarse:h-11"
          size="sm"
          onClick={retry}
        >
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      </>
    );
  } else {
    const { items, total, unavailable } = needs.data;
    const shown = visibleNeeds(items, expanded);
    const note = unavailableNote(unavailable);
    body = (
      <>
        {items.length === 0 ? (
          <div className="flex items-start gap-4 rounded-xl border bg-card p-6">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-stage-closed-bg text-stage-closed-fg">
              <Check aria-hidden="true" className="size-5" />
            </span>
            <div className="grid gap-1">
              <p className="font-medium">Nothing needs you right now.</p>
              <p className="text-sm text-muted-foreground">{CLEAR_HINT_BY_ROLE[role ?? 'lead']}</p>
            </div>
          </div>
        ) : (
          <ul ref={list} className="divide-y overflow-hidden rounded-xl border bg-card">
            {shown.map((item, i) => (
              <NeedsRow key={item.key} item={item} primary={i === 0} />
            ))}
          </ul>
        )}
        {!expanded && items.length > NEEDS_YOU_FIRST ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start text-link pointer-coarse:h-11"
            onClick={() => {
              focusAfterExpand.current = true;
              setExpanded(true);
            }}
          >
            Show all {total}
            <ChevronDown aria-hidden="true" />
          </Button>
        ) : null}
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      </>
    );
  }

  return (
    <section
      aria-labelledby="today-needs-you"
      className="flex min-w-0 flex-col gap-3 lg:col-span-2"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="today-needs-you" className="text-base font-semibold">
          Needs you
        </h2>
        <Link
          to={INBOX_PATH}
          className="text-sm font-medium text-link underline-offset-4 hover:underline"
        >
          Open Inbox
        </Link>
      </div>
      {body}
    </section>
  );
}

function ActivityRow({ line, yesterday }: { line: ActivityLine; yesterday: boolean }) {
  const sentence = <MonoText text={line.sentence} ids={line.item.ref ? [line.item.ref] : []} />;
  return (
    <li className="grid grid-cols-[4.75rem_auto_1fr] items-baseline gap-2">
      <time
        dateTime={line.item.occurredAt}
        className="font-mono text-[13px] whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {yesterday ? <span className="sr-only">Yesterday </span> : null}
        {line.time}
      </time>
      <span
        aria-hidden="true"
        className={cn('size-2 translate-y-[-1px] rounded-full', STAGE_MARK_BG[line.stage])}
      />
      <span className="min-w-0">
        {line.item.href ? (
          <Link to={line.item.href} className="underline-offset-4 hover:underline">
            {sentence}
          </Link>
        ) : (
          sentence
        )}
      </span>
    </li>
  );
}

function LastDay({ role, now }: { role: TodayRole | null; now: Date }) {
  const scope = role ? ACTIVITY_SCOPE_BY_ROLE[role] : null;
  const [activity, retry] = useLoad(`activity:${scope ?? 'waiting'}`, () =>
    scope ? fetchActivity(scope) : WAITING,
  );

  let body;
  if (activity.state === 'loading') {
    body = (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">Loading the last 24 hours…</span>
        <Skeleton className="h-5 w-full" aria-hidden="true" />
        <Skeleton className="h-5 w-4/5" aria-hidden="true" />
      </div>
    );
  } else if (activity.state === 'error') {
    body = (
      <>
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle className="line-clamp-none">The last 24 hours couldn’t load.</AlertTitle>
          <AlertDescription>Shortcuts and Needs you still work.</AlertDescription>
        </Alert>
        <Button
          variant="outline"
          size="sm"
          className="self-start pointer-coarse:h-11"
          onClick={retry}
        >
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      </>
    );
  } else {
    const { today, yesterday } = splitActivity(activity.data, now);
    body =
      today.length + yesterday.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing recorded in the last 24 hours.</p>
      ) : (
        <ol className="flex flex-col gap-4 text-sm">
          {today.map((line) => (
            <ActivityRow key={line.item.id} line={line} yesterday={false} />
          ))}
          {yesterday.length > 0 ? (
            <li aria-hidden="true" className="-mb-2 text-[13px] font-medium text-muted-foreground">
              Yesterday
            </li>
          ) : null}
          {yesterday.map((line) => (
            <ActivityRow key={line.item.id} line={line} yesterday />
          ))}
        </ol>
      );
  }

  return (
    <section aria-labelledby="today-last-day" className="flex min-w-0 flex-col gap-3">
      <h2 id="today-last-day" className="text-base font-semibold">
        Last 24 hours
      </h2>
      {body}
    </section>
  );
}

function PersonalToday({ me }: { me: MeResponse }) {
  const [now] = useState(() => new Date());
  const role = useTodayRole(me);
  const [needs, retryNeeds] = useLoad('needs-you', fetchNeedsYou);
  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-8">
      <Welcome me={me} now={now} needs={needs} />
      <Shortcuts role={role} me={me} />
      <StationSetupCard />
      <div className="grid items-start gap-8 lg:grid-cols-3">
        <NeedsYou needs={needs} retry={retryNeeds} role={role} />
        <LastDay role={role} now={now} />
      </div>
    </div>
  );
}

/** `/`: the LAB station's Today on a station, else the person's own Today. */
export function TodayPage() {
  const me = useMe();
  const { isStation } = useRecordingPerson();
  if (isStation || me.accountType === 'shared_lab') return <StationToday />;
  return <PersonalToday me={me} />;
}
