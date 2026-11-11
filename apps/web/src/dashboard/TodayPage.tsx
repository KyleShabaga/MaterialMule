import type { ActivityItem, MeResponse, StorageLocation } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { fetchOpenCount } from '../action-requests/api';
import { EmptyState, ErrorState, StatusBadge } from '../components/ui';
import { useMediaQuery } from '../components/useMediaQuery';
import { FEATURES } from '../features';
import { PHONE_QUERY } from '../layout/AppLayout';
import { ContextRow } from '../layout/ContextRow';
import { formatUnitCount } from '../receiving/draft';
import { useMe } from '../session/context';
import { fetchSystemStatus } from '../settings/system-status/api';
import {
  fetchLedger,
  fetchLocations,
  fetchOpenConflicts,
  fetchOpenPrograms,
  fetchRecentlyReceived,
  fetchRetentionDue,
  type Loaded,
} from './api';
import { resumeDraftPath, useDashboardDrafts, type DraftsState } from './drafts';
import { shortTime } from './format';
import {
  byUrgency,
  firstName,
  greeting,
  listNames,
  locationCells,
  plural,
  ROOM_LOCATIONS_MAX,
  shortTodayLine,
  todayLine,
  wholeDays,
  type NeedsItem,
} from './today';
import { useLoad, type LoadState } from './useLoad';
import './dashboard.css';

// Today (Field Ledger; docs/redesign/design.md "UX changes", canvas Main and PhoneToday): the ink
// greeting block, the counts, the "Needs you" queue where each row links to the screen that
// clears it, the last 24 hours of the ledger, and the storage room drawn as cells. Every count
// comes from a list or count the app already has; a kind this account can't read is left out.

/** A load that is never made for this session (feature off or no permission). */
const SKIPPED: Promise<Loaded<never>> = Promise.resolve({
  ok: false,
  message: '',
  forbidden: true,
});
const skip = () => SKIPPED;

/** The value of a ready load, else null (loading, refused, failed). */
function ready<T>(state: LoadState<T>): T | null {
  return state.state === 'ready' ? state.data : null;
}

function useToday(me: MeResponse) {
  const has = (permission: string) => (me.permissions as readonly string[]).includes(permission);
  const [ledger, retryLedger] = useLoad('ledger', fetchLedger);
  const [labels] = useLoad('labels', () => fetchRecentlyReceived('labels', 5));
  const [conflicts] = useLoad('conflicts', fetchOpenConflicts);
  const [locations, retryLocations] = useLoad('locations', fetchLocations);
  const [retention] = useLoad('retention', FEATURES.disposalRetention ? fetchRetentionDue : skip);
  const [programs] = useLoad(
    'programs',
    FEATURES.labTesting && has('lab_program.read') ? fetchOpenPrograms : skip,
  );
  const [status] = useLoad('status', has('system.status.read') ? fetchSystemStatus : skip);
  const [actions, setActions] = useState<number | null>(null);
  const canAct = has('action_item.read');
  useEffect(() => {
    if (!canAct) return;
    let active = true;
    void fetchOpenCount()
      .then((value) => active && setActions(value))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [canAct]);
  const drafts = useDashboardDrafts(me);
  return {
    ledger,
    retryLedger,
    labels,
    conflicts,
    locations,
    retryLocations,
    retention,
    programs,
    status,
    actions,
    drafts,
  };
}

type TodayData = ReturnType<typeof useToday>;

/** The "Needs you" rows that apply now, most urgent first. */
function needsItems(data: TodayData): NeedsItem[] {
  const items: NeedsItem[] = [];
  const status = ready(data.status);
  if (status && !status.printWorker.running) {
    items.push({
      key: 'print-queue',
      tag: { label: 'Print', tone: 'danger' },
      title: 'The print queue has stopped',
      sub: 'No label prints until it runs again',
      action: 'Open System status',
      href: '/settings/system-status',
      why: 'NO LABEL CAN PRINT UNTIL THE QUEUE RUNS',
      lead: 'Start with the print queue',
    });
  }
  if (data.actions) {
    items.push({
      key: 'action-requests',
      tag: { label: 'Action', tone: 'flag' },
      title: `${plural(data.actions, 'action request')} ${data.actions === 1 ? 'waits' : 'wait'} on you`,
      sub: 'Each one closes when the real action is done',
      action: 'Open',
      href: '/action-requests',
      why: 'ROUTED TO YOU BY NAME',
      lead: 'Start with your action requests',
    });
  }
  const labels = ready(data.labels);
  if (labels && labels.labelsToCheck > 0) {
    const first = labels.items[0];
    items.push({
      key: 'labels',
      tag: { label: 'Print', tone: 'waiting' },
      title: `${plural(labels.labelsToCheck, 'label')} to check`,
      sub: `Sent to the printer; nobody has confirmed ${labels.labelsToCheck === 1 ? 'it' : 'they'} came out${
        first ? ` · ${first.readableId}${labels.labelsToCheck > 1 ? ' first' : ''}` : ''
      }`,
      action: 'Check',
      href: first ? `/sample-storage/${encodeURIComponent(first.readableId)}` : '/sample-storage',
      why: 'A UNIT WITHOUT ITS LABEL CANNOT BE SCANNED',
      lead: 'Start with the labels',
    });
  }
  const conflicts = ready(data.conflicts);
  if (conflicts && conflicts.total > 0) {
    items.push({
      key: 'conflicts',
      tag: { label: 'Location', tone: 'waiting' },
      title: `${formatUnitCount(conflicts.total)} ${conflicts.total === 1 ? 'needs its' : 'need their'} location confirmed`,
      sub: 'Two moves disagree about where the unit is',
      action: 'Confirm',
      href: '/sample-storage?conflict=open',
      why: 'THE RECORD AND THE SHELF DISAGREE',
      lead: 'Start with the location check',
    });
  }
  if (data.drafts.state === 'ready' && data.drafts.drafts.length > 0) {
    const list = data.drafts.drafts;
    const projects = list.flatMap((d) => (d.data.project ? [d.data.project.projectNumber] : []));
    const units = list.reduce((sum, d) => sum + d.data.units.length, 0);
    items.push({
      key: 'drafts',
      tag: { label: 'Draft', tone: 'waiting' },
      title:
        list.length === 1
          ? `A receipt${projects[0] ? ` for ${projects[0]}` : ''} is waiting to be confirmed`
          : `${list.length} receipts are waiting to be confirmed`,
      sub: `${formatUnitCount(units)}${projects.length && list.length > 1 ? ` · ${listNames(projects)}` : ''} · on this computer · IDs issue when you confirm`,
      action: list.length === 1 ? 'Continue' : 'Review',
      href: list.length === 1 ? resumeDraftPath(list[0]!) : '/receiving-log/new',
      why: 'NO ID IS ISSUED UNTIL YOU CONFIRM',
      lead: list.length === 1 ? 'Finish the draft receipt' : 'Finish the draft receipts',
    });
  }
  const retention = ready(data.retention);
  if (retention && retention.total > 0) {
    items.push({
      key: 'retention',
      tag: { label: 'Due', tone: 'danger' },
      title: `${formatUnitCount(retention.total)} ${retention.total === 1 ? 'has' : 'have'} reached the end of retention`,
      sub: listNames(retention.items.map((unit) => unit.project.projectNumber)),
      action: 'Decide',
      href: '/disposal-retention',
      why: 'PAST THE RETAIN-UNTIL DATE',
      lead: 'Start with retention',
    });
  }
  const programs = ready(data.programs);
  if (programs && programs.total > 0) {
    const oldest = Math.max(0, ...programs.items.map((p) => p.oldestOpenSeconds ?? 0));
    const tests = programs.items.reduce((sum, p) => sum + p.openCount, 0);
    items.push({
      key: 'lab',
      tag: { label: 'Lab', tone: 'lab' },
      title: `${plural(programs.total, 'lab program')} ${programs.total === 1 ? 'has' : 'have'} open tests`,
      sub: `${plural(tests, 'open test')}${programs.total > programs.items.length ? ' on this page' : ''} · ${listNames(programs.items.map((p) => p.project.projectNumber))}`,
      action: 'Open',
      href: '/lab-testing',
      lead: 'Start with the lab',
      why: `OLDEST OPEN TEST: ${plural(wholeDays(oldest), 'DAY')} OLD`,
    });
  }
  return byUrgency(items);
}

function Greeting({
  me,
  items,
  now,
  labName,
}: {
  me: MeResponse;
  items: NeedsItem[];
  now: Date;
  labName: string | null;
}) {
  const name = me.accountType === 'shared_lab' ? null : firstName(me.displayName);
  const first = items[0];
  return (
    <section className="today-greeting" aria-labelledby="today-greeting">
      <div className="today-greeting-text">
        <p className="today-greeting-line mono">
          TODAY · {todayLine(now)}
          {labName ? ` · ${labName.toUpperCase()}` : ''}
        </p>
        <h1 id="today-greeting">{greeting(name, items.length, now)}</h1>
      </div>
      {first ? (
        <div className="today-greeting-next">
          <Link className="button primary today-greeting-action" to={first.href}>
            {first.lead}
          </Link>
          <span className="today-greeting-why mono">{first.why}</span>
        </div>
      ) : null}
    </section>
  );
}

function CountStrip({ data }: { data: TodayData }) {
  const cells: { label: string; n: number | null; sub: string; href: string }[] = [];
  cells.push({
    label: 'DRAFT RECEIPTS',
    n: data.drafts.state === 'ready' ? data.drafts.drafts.length : null,
    sub: 'on this computer',
    href: '/receiving-log/new',
  });
  const labels = ready(data.labels);
  cells.push({
    label: 'LABELS TO CHECK',
    n: labels ? labels.labelsToCheck : null,
    sub: 'not confirmed as printed',
    href: labels?.items[0]
      ? `/sample-storage/${encodeURIComponent(labels.items[0].readableId)}`
      : '/sample-storage',
  });
  if (FEATURES.labTesting && data.programs.state !== 'error') {
    const programs = ready(data.programs);
    cells.push({
      label: 'OPEN LAB PROGRAMS',
      n: programs ? programs.total : null,
      sub: 'with tests to do',
      href: '/lab-testing',
    });
  }
  if (FEATURES.disposalRetention && data.retention.state !== 'error') {
    const retention = ready(data.retention);
    cells.push({
      label: 'RETENTION DUE',
      n: retention ? retention.total : null,
      sub: 'past the retain-until date',
      href: '/disposal-retention',
    });
  }
  return (
    <ul className="today-counts" aria-label="Counts">
      {cells.map((cell) => (
        <li key={cell.label}>
          <Link
            to={cell.href}
            className="today-count"
            aria-label={`${cell.label.toLowerCase()}: ${cell.n ?? 'loading'}, ${cell.sub}`}
          >
            <span className="field-label">{cell.label}</span>
            <span className="today-count-n" aria-busy={cell.n === null || undefined}>
              {cell.n ?? '–'}
            </span>
            <span className="today-count-sub">{cell.sub}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function NeedsYou({ items, loading }: { items: NeedsItem[]; loading: boolean }) {
  return (
    <section className="today-section today-needs" aria-labelledby="today-needs">
      <div className="section-head">
        <h2 id="today-needs">Needs you</h2>
        <span className="section-meta">{plural(items.length, 'ITEM')}</span>
      </div>
      {items.length === 0 ? (
        loading ? (
          <p className="muted" aria-busy="true">
            Checking what needs you…
          </p>
        ) : (
          <EmptyState title="Nothing needs you.">
            No drafts to confirm, no labels waiting, nothing due. New work shows up here.
          </EmptyState>
        )
      ) : (
        <ul className="today-tasks">
          {items.map((item) => (
            <li key={item.key} className="today-task" data-row>
              <StatusBadge tone={item.tag.tone}>{item.tag.label}</StatusBadge>
              <div className="today-task-text">
                <p className="today-task-title">{item.title}</p>
                <p className="today-task-sub">{item.sub}</p>
              </div>
              <Link className="button today-task-action" to={item.href}>
                {item.action}
                <span className="visually-hidden">: {item.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Ledger({ ledger, retry }: { ledger: LoadState<ActivityItem[]>; retry: () => void }) {
  return (
    <section className="today-section today-ledger" aria-labelledby="today-ledger">
      <div className="section-head">
        <h2 id="today-ledger">Ledger</h2>
        <span className="section-meta">LAST 24 H</span>
      </div>
      {ledger.state === 'loading' ? (
        <p className="muted" aria-busy="true">
          Loading the ledger…
        </p>
      ) : ledger.state === 'error' ? (
        <ErrorState message={ledger.message} detail="Nothing was changed." onRetry={retry} />
      ) : ledger.data.length === 0 ? (
        <EmptyState title="Nothing recorded in the last 24 hours.">
          Receipts, labels, corrections, moves and disposals show up here as they happen.
        </EmptyState>
      ) : (
        <ul className="today-ledger-list">
          {ledger.data.map((item) => (
            <li key={item.id} data-row>
              <time className="mono" dateTime={item.occurredAt}>
                {shortTime(item.occurredAt)}
              </time>
              <div>
                <p className="today-ledger-what">
                  {item.href ? <Link to={item.href}>{item.summary}</Link> : item.summary}
                </p>
                {item.ref ? <p className="today-ledger-ref mono">{item.ref}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StorageRoom({ data }: { data: TodayData }) {
  const locations = data.locations;
  const retention = ready(data.retention);
  const dueAt = new Map<string, number>();
  for (const unit of retention?.items ?? []) {
    dueAt.set(unit.location.id, (dueAt.get(unit.location.id) ?? 0) + 1);
  }
  const all =
    locations.state === 'ready'
      ? [...locations.data].filter((l) => l.active).sort((a, b) => b.inStockCount - a.inStockCount)
      : [];
  const shown = all.slice(0, ROOM_LOCATIONS_MAX);
  return (
    <section className="today-section today-room" aria-labelledby="today-room">
      <div className="section-head">
        <h2 id="today-room">Storage room</h2>
        <span className="section-meta">UNITS BY LOCATION</span>
      </div>
      {locations.state === 'loading' ? (
        <p className="muted" aria-busy="true">
          Loading the storage room…
        </p>
      ) : locations.state === 'error' ? (
        <ErrorState
          message={locations.message}
          detail="Nothing was changed."
          onRetry={data.retryLocations}
        />
      ) : shown.length === 0 ? (
        <EmptyState title="No locations yet.">
          Locations appear here once they are set up in Settings, Locations.
        </EmptyState>
      ) : (
        <>
          <ul className="today-bays">
            {shown.map((location) => {
              const due = dueAt.get(location.id) ?? 0;
              const cells = locationCells(location.inStockCount, due);
              const extra = location.inStockCount - cells.length;
              return (
                <li key={location.id} className="today-bay">
                  <Link
                    to={`/sample-storage?locationId=${encodeURIComponent(location.id)}`}
                    className="today-bay-head"
                  >
                    <span className="today-bay-name">{location.name}</span>
                    <span className="mono today-bay-count">
                      {formatUnitCount(location.inStockCount)}
                    </span>
                  </Link>
                  {cells.length > 0 ? (
                    <span
                      className="today-bay-cells"
                      role="img"
                      aria-label={`${location.name}: ${formatUnitCount(location.inStockCount)}${
                        due ? `, ${due} with retention due` : ''
                      }`}
                    >
                      {cells.map((state, i) => (
                        <span key={i} className={`counted-cell counted-cell-${state}`} />
                      ))}
                    </span>
                  ) : (
                    <span className="today-bay-empty">Empty</span>
                  )}
                  {extra > 0 ? <span className="today-bay-more mono">+{extra} more</span> : null}
                </li>
              );
            })}
          </ul>
          <div className="today-legend" aria-hidden="true">
            <span>
              <span className="counted-cell counted-cell-done" />
              In storage
            </span>
            {FEATURES.disposalRetention ? (
              <span>
                <span className="counted-cell counted-cell-current" />
                Retention due
              </span>
            ) : null}
          </div>
          {all.length > shown.length ? (
            <p className="today-more">
              <Link to="/settings/locations">
                {plural(all.length - shown.length, 'more location')} in Settings, Locations
              </Link>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The receiving lab's name for the greeting's date line (the one system location). */
function receivingLabName(locations: LoadState<StorageLocation[]>): string | null {
  const lab = ready(locations)?.find((location) => location.kind === 'receiving_lab');
  return lab?.name ?? null;
}

function draftsLoading(drafts: DraftsState): boolean {
  return drafts.state === 'loading';
}

export function TodayPage() {
  const me = useMe();
  const phone = useMediaQuery(PHONE_QUERY);
  const data = useToday(me);
  const [now] = useState(() => new Date());
  const items = needsItems(data);
  const loading =
    draftsLoading(data.drafts) ||
    [data.labels, data.conflicts, data.retention, data.programs, data.status].some(
      (s) => s.state === 'loading',
    );

  if (phone) {
    return (
      <div className="today today-phone">
        <div className="today-phone-head">
          <h1>Today</h1>
          <span className="mono today-phone-date">{shortTodayLine(now)}</span>
        </div>
        <Link to="/sample-storage/scan" className="today-scan">
          <span className="today-scan-title">Scan a label</span>
          <span className="today-scan-sub">Find, move or check out a unit</span>
        </Link>
        <Link className="button today-receive" to="/receiving-log/new">
          Receive samples
        </Link>
        <CountStrip data={data} />
        <NeedsYou items={items} loading={loading} />
        <Ledger ledger={data.ledger} retry={data.retryLedger} />
      </div>
    );
  }

  return (
    <div className="today">
      <ContextRow align="end">
        <Link className="button" to="/sample-storage/scan">
          Scan label
        </Link>
        <Link className="button primary" to="/receiving-log/new">
          Receive samples
        </Link>
      </ContextRow>
      <Greeting me={me} items={items} now={now} labName={receivingLabName(data.locations)} />
      <CountStrip data={data} />
      <div className="today-split">
        <NeedsYou items={items} loading={loading} />
        <Ledger ledger={data.ledger} retry={data.retryLedger} />
      </div>
      <StorageRoom data={data} />
    </div>
  );
}
