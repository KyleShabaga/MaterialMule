import {
  stationCountText,
  type StationConfig,
  type StationRow,
  type StationToday as StationTodayCounts,
} from '@materialmule/shared';
import {
  ArrowDownToLine,
  ArrowRight,
  ChevronRight,
  CircleAlert,
  Cylinder,
  Hammer,
  RotateCw,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { StoredDraft } from '../../receiving/drafts/record';
import { useMe } from '../../session/context';
import { useRecordingPerson } from '../../session/recording-person';
import { useDashboardDrafts } from '../drafts';
import { defaultStationConfig, fetchStationConfig, fetchStationToday } from './api';
import { CustomizeStation } from './CustomizeStation';
import { stationId } from './station-id';
import { hiddenRowsNote, NOTHING_WAITING, rowCount, STATION_ROW_INFO } from './rows';

// Today on a LAB station (STRATA-20, 21, 63; DESIGN.md › Today on a LAB station): who the work
// is recorded as, three equal tiles (Receive samples, Receive concrete, Record breaks), then this
// station's waiting work, customised per computer. No greeting: the sidebar shows who is
// recording. Mouse and keyboard: standard density (STRATA-62, 44 px targets are touch-only).

export const RECEIVE_SAMPLES_PATH = '/receiving-log/new';
export const RECEIVE_CONCRETE_PATH = '/concrete/receiving';
/** STRATA-63 variant A: the concrete breaks due list, which leads on to the Testing table. */
export const RECORD_BREAKS_PATH = '/lab-testing/concrete';

export const COULD_NOT_LOAD = 'Couldn’t load.';

interface Tile {
  to: string;
  icon: LucideIcon;
  title: string;
  line: string;
}

const TILES: Tile[] = [
  {
    to: RECEIVE_SAMPLES_PATH,
    icon: ArrowDownToLine,
    title: 'Receive samples',
    line: 'Buckets, Shelby tubes and core boxes arriving at the lab.',
  },
  {
    to: RECEIVE_CONCRETE_PATH,
    icon: Cylinder,
    title: 'Receive concrete',
    line: 'Specimen sets arriving from site.',
  },
  {
    to: RECORD_BREAKS_PATH,
    icon: Hammer,
    title: 'Record breaks',
    line: 'Specimen breaks due today at this station.',
  },
];

const ROW_MARK: Record<StationRow, string> = {
  drafts: 'bg-stage-draft-mark',
  breaks_due: 'bg-stage-lab-mark',
  labels_to_print: 'bg-stage-due-mark',
};

type Counts =
  { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: StationTodayCounts };

export function StationToday() {
  const me = useMe();
  const { person } = useRecordingPerson();
  const drafts = useDashboardDrafts(me);
  const [id] = useState(stationId);
  const [attempt, setAttempt] = useState(0);
  const [counts, setCounts] = useState<Counts>({ state: 'loading' });
  const [config, setConfig] = useState<StationConfig | null>(null);

  useEffect(() => {
    let active = true;
    void fetchStationToday().then((data) => {
      if (active) setCounts(data ? { state: 'ready', data } : { state: 'failed' });
    });
    void fetchStationConfig(id).then((loaded) => {
      // A config that can't be read shows the defaults: every row, in the default order.
      if (active) setConfig(loaded ?? defaultStationConfig(id));
    });
    return () => {
      active = false;
    };
  }, [id, attempt]);

  const retry = useCallback(() => {
    setCounts({ state: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  const shown = config?.rows.filter((entry) => entry.visible) ?? [];
  const hidden = config ? config.rows.length - shown.length : 0;
  const localDrafts: StoredDraft[] | null =
    drafts.state === 'ready' ? drafts.drafts : drafts.state === 'error' ? [] : null;

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8 px-4 py-8 sm:px-8">
      <h1 className="sr-only">Today</h1>
      {person ? (
        <p className="flex items-center gap-3 rounded-lg bg-accent px-4 py-3 text-sm text-accent-foreground">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-background font-mono text-[13px] font-bold text-foreground"
          >
            {person.initials}
          </span>
          <span>
            Work started here is recorded as{' '}
            <span className="font-semibold">{person.displayName}</span>. Not you? Switch person from{' '}
            <span className="font-semibold">Recording as</span> at the top.
          </span>
        </p>
      ) : null}

      <nav aria-label="Start work" className="grid gap-4 sm:grid-cols-3">
        {TILES.map((tile) => (
          <StartTile key={tile.to} tile={tile} />
        ))}
      </nav>

      <section aria-labelledby="station-work" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h2 id="station-work" className="text-base font-semibold">
            At this station
          </h2>
          {config ? <CustomizeStation config={config} editable={false} /> : null}
        </div>
        {config && shown.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-[10px] border border-dashed p-6 text-sm text-muted-foreground">
            <p>Nothing is set to show at this station.</p>
            <CustomizeStation config={config} editable={false} />
          </div>
        ) : counts.state === 'failed' ? (
          <div className="flex flex-col items-start gap-3">
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle className="line-clamp-none">
                This station’s work couldn’t load.
              </AlertTitle>
              <AlertDescription>The receiving buttons above still work.</AlertDescription>
            </Alert>
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          </div>
        ) : counts.state === 'loading' || !config || localDrafts === null ? (
          <p aria-busy="true" className="text-sm text-muted-foreground">
            Loading this station’s work…
          </p>
        ) : (
          <>
            <ul className="divide-y overflow-hidden rounded-[10px] border bg-card">
              {shown.map(({ row }) => (
                <CountRow key={row} row={row} count={rowCount(row, counts.data, localDrafts)} />
              ))}
            </ul>
            {hiddenRowsNote(hidden) ? (
              <p className="text-[13px] text-muted-foreground">{hiddenRowsNote(hidden)}</p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function StartTile({ tile }: { tile: Tile }) {
  const Icon = tile.icon;
  return (
    <Link
      to={tile.to}
      className="group flex min-h-36 flex-col gap-4 rounded-[10px] border bg-card p-5 text-card-foreground no-underline shadow-xs outline-none transition-colors duration-150 hover:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none"
    >
      <span className="flex items-start justify-between">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Icon aria-hidden="true" className="size-6" />
        </span>
        <ArrowRight
          aria-hidden="true"
          className="size-5 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-link motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
        />
      </span>
      <span className="grid gap-1">
        <span className="text-lg font-semibold">{tile.title}</span>
        <span className="text-sm text-muted-foreground">{tile.line}</span>
      </span>
    </Link>
  );
}

function CountRow({ row, count }: { row: StationRow; count: number | null }) {
  const info = STATION_ROW_INFO[row];
  const waiting = count !== null && count > 0;
  return (
    <li>
      <Link
        to={info.href}
        data-row={row}
        className="relative flex min-h-16 items-center gap-5 px-5 py-3 text-foreground no-underline outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-2.5 bottom-2.5 left-1 w-1 rounded-full',
            waiting && ROW_MARK[row],
          )}
        />
        <span
          className={cn(
            'w-12 shrink-0 text-right font-mono text-2xl font-semibold tabular-nums',
            waiting ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {count === null ? <span aria-hidden="true">–</span> : stationCountText(count)}
        </span>
        <span className="grid flex-1 gap-0.5">
          <span className="font-medium">{info.title}</span>
          <span className="text-sm text-muted-foreground">
            {count === null ? COULD_NOT_LOAD : waiting ? info.line : NOTHING_WAITING}
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
      </Link>
    </li>
  );
}
