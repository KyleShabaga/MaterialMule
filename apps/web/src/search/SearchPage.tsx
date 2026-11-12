import type { ConcreteSearch, LabProgramList } from '@materialmule/shared';
import { SearchX, TextSearch, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { PageHeader } from '../components/app-ui';
import { useMediaQuery } from '../components/useMediaQuery';
import { FEATURES } from '../features';
import { useOptionalCommandMenu } from './command-menu';
import {
  SEARCH_PREVIEW,
  SEARCH_UNIT_PAGE,
  searchConcrete,
  searchLocations,
  searchPrograms,
  searchProjects,
  searchReceipts,
  searchUnits,
  type SearchResult,
} from './api';
import {
  concreteSetRows,
  plural,
  programRow,
  projectRow,
  receiptRow,
  shelfRow,
  testHoleRows,
  unitRow,
  type ResultRow,
  type UnitRow,
} from './rows';
import { StageTag } from './StageTag';

// Strata search results (STRATA-82, DESIGN.md › Round 3 "Search results"): `/search?q=`, from the
// Ctrl K menu's "Show all results". Grouped by kind, each group with an honest count: where a
// group only lists a preview (capped by the source), it says so instead of passing the preview
// off as the total. Storage units carry their stage tag (STRATA-60).

const PHONE_QUERY = '(max-width: 640px)';

const SEARCHED_KINDS = [
  'storage units',
  'test holes',
  'projects',
  'shelves',
  'receipts',
  ...(FEATURES.labTesting ? ['lab programs'] : []),
  ...(FEATURES.concreteLab ? ['concrete records'] : []),
]
  .join(', ')
  .replace(/, ([^,]+)$/, ' and $1');

type GroupKey = 'holes' | 'units' | 'projects' | 'shelves' | 'receipts' | 'programs' | 'concrete';

/** Phone filter (canvas PhoneFind): All, Units, Holes, Programs. */
type PhoneFilter = 'all' | 'units' | 'holes' | 'programs';
const PHONE_FILTERS: { value: PhoneFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'units', label: 'Units' },
  { value: 'holes', label: 'Holes' },
  { value: 'programs', label: 'Programs' },
];

/** The answer for the current query only; an older query's late answer is never shown. */
function useResult<T>(q: string, load: (q: string) => Promise<T>): T | null {
  const [answer, setAnswer] = useState<{ q: string; value: T } | null>(null);
  useEffect(() => {
    if (!q) return;
    let current = true;
    void load(q).then((value) => current && setAnswer({ q, value }));
    return () => {
      current = false;
    };
  }, [q, load]);
  return answer?.q === q ? answer.value : null;
}

const loadUnits = (q: string) => searchUnits(q);
const loadConcrete = (q: string) => searchConcrete(q);
const refused = <T,>(): Promise<SearchResult<T>> =>
  Promise.resolve({ ok: false, forbidden: true, message: '' });
const noPrograms = () => refused<LabProgramList>();
const noConcrete = () => refused<ConcreteSearch>();

interface Group {
  key: GroupKey;
  title: string;
  /** "3 matches", or what a capped preview really shows ("First 5 shown"). */
  count: string;
  rows: ResultRow[];
  more?: { to: string; label: string };
  note?: string;
}

function matches(n: number): string {
  return plural(n, 'match', 'matches');
}

function GroupCard({
  title,
  count,
  more,
  note,
  children,
}: {
  title: string;
  count: string;
  more?: { to: string; label: string };
  note?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <Card role="region" aria-labelledby={headingId} className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>
          <h2 id={headingId} className="text-base font-semibold">
            {title}
          </h2>
        </CardTitle>
        <CardAction>
          <span className="font-mono text-xs text-muted-foreground uppercase">{count}</span>
        </CardAction>
      </CardHeader>
      <CardContent className="px-4">
        {children}
        {note ? <p className="mt-2 text-xs text-muted-foreground">{note}</p> : null}
        {more ? (
          <p className="mt-3 text-sm">
            <Link className="text-link underline-offset-4 hover:underline" to={more.to}>
              {more.label}
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ResultTable({ rows, label }: { rows: ResultRow[]; label: string }) {
  return (
    <Table aria-label={label}>
      <TableHeader className="sr-only">
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell className="w-0 align-top">
              <Link
                to={row.href}
                className="font-mono font-medium whitespace-nowrap text-link underline-offset-4 hover:underline"
              >
                {row.id} <span className="sr-only">{row.title}</span>
              </Link>
            </TableCell>
            <TableCell className="min-w-0 whitespace-normal">
              <div>{row.title}</div>
              {row.sub ? <div className="text-xs text-muted-foreground">{row.sub}</div> : null}
            </TableCell>
            <TableCell className="w-0 text-right">
              {row.tag ? <StageTag stage={row.tag.stage}>{row.tag.label}</StageTag> : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function UnitTable({ rows }: { rows: UnitRow[] }) {
  return (
    <Table aria-label="Storage units">
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Project</TableHead>
          <TableHead>Test holes</TableHead>
          <TableHead>Where</TableHead>
          <TableHead className="text-right">Stage</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell className="w-0">
              <Link
                to={row.href}
                className="font-mono font-medium whitespace-nowrap text-link underline-offset-4 hover:underline"
              >
                {row.id}
              </Link>
            </TableCell>
            <TableCell>
              <span className="font-mono">{row.projectNumber}</span>{' '}
              <span className="text-muted-foreground">{row.type}</span>
            </TableCell>
            <TableCell className="whitespace-normal">{row.contents}</TableCell>
            <TableCell className="whitespace-normal">{row.where}</TableCell>
            <TableCell className="w-0 text-right">
              <StageTag stage={row.stage.stage}>{row.stage.label}</StageTag>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function LoadingGroups() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      {[0, 1].map((n) => (
        <Card key={n} className="gap-3 py-4">
          <CardContent className="flex flex-col gap-2 px-4">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function SearchPage() {
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const phone = useMediaQuery(PHONE_QUERY);
  const menu = useOptionalCommandMenu();
  const [filter, setFilter] = useState<PhoneFilter>('all');

  const units = useResult(q, loadUnits);
  const projects = useResult(q, searchProjects);
  const shelves = useResult(q, searchLocations);
  const receipts = useResult(q, searchReceipts);
  const programs = useResult(q, FEATURES.labTesting ? searchPrograms : noPrograms);
  const concrete = useResult(q, FEATURES.concreteLab ? loadConcrete : noConcrete);

  if (!q) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Search" documentTitle={false} />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TextSearch />
            </EmptyMedia>
            <EmptyTitle>Type what you are looking for.</EmptyTitle>
            <EmptyDescription>
              A unit ID, project, test hole, sample, shelf or lab program. A scanned label opens the
              unit.
            </EmptyDescription>
          </EmptyHeader>
          {menu ? (
            <EmptyContent>
              <Button variant="outline" onClick={() => menu.open()}>
                Search or scan
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      </div>
    );
  }

  const encoded = encodeURIComponent(q);
  const results = [units, projects, shelves, receipts, programs, concrete];
  const loading = results.some((r) => r === null);
  const failures = results.filter(
    (r): r is { ok: false; forbidden: false; message: string } => !!r && !r.ok && !r.forbidden,
  );

  const groups: Group[] = [];
  let unitRows: UnitRow[] = [];
  let unitCount = '';
  let unitMore: Group['more'];
  if (units?.ok) {
    const holes = testHoleRows(units.data.items, q);
    // Test holes are found through the units read, so past that page the list is partial.
    const holesPartial = units.data.total > units.data.items.length;
    if (holes.length) {
      groups.push({
        key: 'holes',
        title: 'Test holes',
        count: holesPartial ? `${holes.length} found so far` : matches(holes.length),
        rows: holes,
        note: holesPartial
          ? `Found through the first ${SEARCH_UNIT_PAGE} matching storage units; there may be more.`
          : undefined,
        more: holesPartial
          ? { to: `/sample-storage?search=${encoded}&status=all`, label: 'Show all in Inventory' }
          : undefined,
      });
    }
    if (units.data.total > 0) {
      unitRows = units.data.items.slice(0, SEARCH_PREVIEW).map(unitRow);
      unitCount = matches(units.data.total);
      unitMore =
        units.data.total > SEARCH_PREVIEW
          ? { to: `/sample-storage?search=${encoded}&status=all`, label: 'Show all in Inventory' }
          : undefined;
    }
  }
  if (projects?.ok && projects.data.length > 0) {
    // The project search returns at most a preview; a full preview may not be every match.
    const capped = projects.data.length >= SEARCH_PREVIEW;
    groups.push({
      key: 'projects',
      title: 'Projects',
      count: capped ? `First ${projects.data.length} shown` : matches(projects.data.length),
      rows: projects.data.map(projectRow),
      more: { to: `/projects?search=${encoded}`, label: 'Show all in Projects' },
    });
  }
  if (shelves?.ok && shelves.data.length > 0) {
    groups.push({
      key: 'shelves',
      title: 'Shelves',
      count: matches(shelves.data.length),
      rows: shelves.data.slice(0, SEARCH_PREVIEW).map(shelfRow),
      note:
        shelves.data.length > SEARCH_PREVIEW
          ? `Showing ${SEARCH_PREVIEW} of ${shelves.data.length}. Type more of the shelf code to narrow it.`
          : undefined,
    });
  }
  if (receipts?.ok && receipts.data.total > 0) {
    groups.push({
      key: 'receipts',
      title: 'Receipts',
      count: matches(receipts.data.total),
      rows: receipts.data.items.map(receiptRow),
      more:
        receipts.data.total > receipts.data.items.length
          ? { to: `/receiving-log?search=${encoded}`, label: 'Show all in the Receiving log' }
          : undefined,
    });
  }
  if (programs?.ok && programs.data.total > 0) {
    groups.push({
      key: 'programs',
      title: 'Lab programs',
      count: matches(programs.data.total),
      rows: programs.data.items.slice(0, SEARCH_PREVIEW).map(programRow),
      note:
        programs.data.total > SEARCH_PREVIEW
          ? `Showing ${SEARCH_PREVIEW} of ${programs.data.total}.`
          : undefined,
    });
  }
  if (concrete?.ok && concrete.data.total > 0) {
    groups.push({
      key: 'concrete',
      title: 'Concrete',
      count: plural(concrete.data.total, 'field report'),
      rows: concreteSetRows(concrete.data),
      note: 'Set numbering is open (package 3): sets show the ID they carry today.',
      more: { to: `/concrete/search?q=${encoded}`, label: 'Show all in Concrete' },
    });
  }

  const empty = !loading && failures.length === 0 && groups.length === 0 && unitRows.length === 0;
  const visible = (key: GroupKey) => !phone || filter === 'all' || filter === key;
  const order: GroupKey[] = [
    'units',
    'holes',
    'projects',
    'shelves',
    'receipts',
    'programs',
    'concrete',
  ];
  const byKey = new Map(groups.map((group) => [group.key, group]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <PageHeader title={`Results for “${q}”`} documentTitle={false} />
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {loading ? 'Searching…' : `Searched ${SEARCHED_KINDS}.`}
        </p>
      </div>
      {phone ? (
        <ToggleGroup
          type="single"
          variant="outline"
          aria-label="Show"
          value={filter}
          onValueChange={(next) => next && setFilter(next as PhoneFilter)}
        >
          {PHONE_FILTERS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {failures.map((failure) => (
        <Alert key={failure.message} variant="destructive">
          <TriangleAlert />
          <AlertTitle>{failure.message}</AlertTitle>
          <AlertDescription>Nothing was changed. The other results are below.</AlertDescription>
        </Alert>
      ))}
      {empty ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>Nothing matches.</EmptyTitle>
            <EmptyDescription>
              No unit, project, test hole, shelf or program matches{' '}
              <span className="font-mono">“{q}”</span>. Check the ID, or scan the label again.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {order.map((key) => {
        if (!visible(key)) return null;
        if (key === 'units') {
          return unitRows.length > 0 ? (
            <GroupCard key={key} title="Storage units" count={unitCount} more={unitMore}>
              <UnitTable rows={unitRows} />
            </GroupCard>
          ) : null;
        }
        const group = byKey.get(key);
        if (!group) return null;
        return (
          <GroupCard
            key={key}
            title={group.title}
            count={group.count}
            more={group.more}
            note={group.note}
          >
            <ResultTable rows={group.rows} label={group.title} />
          </GroupCard>
        );
      })}
      {loading ? <LoadingGroups /> : null}
      <p className="text-xs text-muted-foreground">
        A scanned label that matches exactly one unit or shelf skips this page and opens it.
      </p>
    </div>
  );
}
