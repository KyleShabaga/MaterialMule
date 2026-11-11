import { locationKindLabel, type ConcreteSearch, type LabProgramList } from '@materialmule/shared';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState, ErrorState, PageHeader, Segmented, StatusBadge } from '../components/ui';
import { useMediaQuery } from '../components/useMediaQuery';
import { fetchConcreteSearch, LAB_SEARCH_PREVIEW, type LoadResult } from '../concrete/lab/api';
import { ConcreteSearchResults } from '../concrete/lab/ConcreteSearch';
import { FEATURES } from '../features';
import { PHONE_QUERY } from '../layout/AppLayout';
import { ContextRow } from '../layout/ContextRow';
import {
  SEARCH_PREVIEW,
  searchLocations,
  searchPrograms,
  searchProjects,
  searchReceipts,
  searchUnits,
  type SearchResult,
} from './api';
import { plural, PROGRAM_TAG, testHoleRows, unitRow, type ResultRow } from './rows';
import './search.css';

// Field Ledger search results (docs/redesign/design.md, "Search results"; canvas Search and
// PhoneFind): grouped by kind, each row one link. Test holes are found through their storage
// units; samples are matched by the units' SAMPLE#/DEPTH summaries and sample references, since
// receiving keeps no individual sample inventory.

type GroupKey = 'holes' | 'units' | 'projects' | 'shelves' | 'deliveries' | 'programs';

/** Phone filter (canvas PhoneFind): All, Units, Holes, Programs. */
type PhoneFilter = 'all' | 'units' | 'holes' | 'programs';
const PHONE_FILTERS: { value: PhoneFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'units', label: 'Units' },
  { value: 'holes', label: 'Holes' },
  { value: 'programs', label: 'Programs' },
];

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

const loadConcrete = (q: string): Promise<LoadResult<ConcreteSearch>> =>
  fetchConcreteSearch(q, 1, LAB_SEARCH_PREVIEW);
const noConcrete = (): Promise<null> => Promise.resolve(null);
const noPrograms = () =>
  Promise.resolve<SearchResult<LabProgramList>>({
    ok: false,
    forbidden: true,
    message: '',
  });

interface Group {
  key: GroupKey;
  title: string;
  /** Matches in total; may be more than the rows listed. */
  total: number;
  rows: ResultRow[];
  more?: { to: string; label: string };
}

function ResultList({ rows }: { rows: ResultRow[] }) {
  return (
    <ul className="search-rows">
      {rows.map((row) => (
        <li key={row.key}>
          <Link to={row.href} className="search-row" data-row>
            <span className="search-row-id mono">{row.id}</span>
            <span className="search-row-text">
              <span className="search-row-title">{row.title}</span>
              {row.sub ? <span className="search-row-sub">{row.sub}</span> : null}
            </span>
            <StatusBadge tone={row.tag.tone}>{row.tag.label}</StatusBadge>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function GroupSection({
  title,
  count,
  children,
}: {
  title: string;
  count: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="search-group" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 id={headingId}>{title}</h2>
        <span className="section-meta">{count}</span>
      </div>
      {children}
    </section>
  );
}

function matches(n: number): string {
  return `${n} ${n === 1 ? 'MATCH' : 'MATCHES'}`;
}

export function SearchPage() {
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const phone = useMediaQuery(PHONE_QUERY);
  const [filter, setFilter] = useState<PhoneFilter>('all');

  const units = useResult(q, searchUnits);
  const projects = useResult(q, searchProjects);
  const shelves = useResult(q, searchLocations);
  const deliveries = useResult(q, searchReceipts);
  const programs = useResult(q, FEATURES.labTesting ? searchPrograms : noPrograms);
  const concrete = useResult(q, FEATURES.concreteLab ? loadConcrete : noConcrete);

  if (!q) {
    return (
      <div className="search-page">
        <PageHeader title="Search" />
        <EmptyState title="Type what you are looking for.">
          Use the search field at the top of the page: a unit ID, project, test hole, sample, shelf
          or lab program. A scanned label opens the unit.
        </EmptyState>
      </div>
    );
  }

  const encoded = encodeURIComponent(q);
  const results = [units, projects, shelves, deliveries, programs];
  const loading = results.some((r) => r === null) || (FEATURES.concreteLab && concrete === null);
  const failures = results.filter(
    (r): r is { ok: false; forbidden: false; message: string } => !!r && !r.ok && !r.forbidden,
  );

  const groups: Group[] = [];
  if (units?.ok) {
    const holes = testHoleRows(units.data.items, q);
    if (holes.length)
      groups.push({ key: 'holes', title: 'Test holes', total: holes.length, rows: holes });
    if (units.data.total > 0) {
      groups.push({
        key: 'units',
        title: 'Storage units',
        total: units.data.total,
        rows: units.data.items.slice(0, SEARCH_PREVIEW).map(unitRow),
        more:
          units.data.total > SEARCH_PREVIEW
            ? { to: `/sample-storage?search=${encoded}&status=all`, label: 'Show all in Inventory' }
            : undefined,
      });
    }
  }
  if (projects?.ok && projects.data.length > 0) {
    groups.push({
      key: 'projects',
      title: 'Projects',
      total: projects.data.length,
      rows: projects.data.map((project) => ({
        key: project.id,
        id: project.projectNumber,
        title: project.name,
        sub: project.client,
        tag: { label: 'Project', tone: 'closed' },
        href: `/projects/${project.id}`,
      })),
      more: { to: `/projects?search=${encoded}`, label: 'Show all projects' },
    });
  }
  if (shelves?.ok && shelves.data.length > 0) {
    groups.push({
      key: 'shelves',
      title: 'Shelves',
      total: shelves.data.length,
      rows: shelves.data.slice(0, SEARCH_PREVIEW).map((location) => ({
        key: location.id,
        id: location.code,
        title: location.name,
        sub: `${plural(location.inStockCount, 'unit')} · ${locationKindLabel(location.kind)}`,
        tag: location.active
          ? { label: 'Shelf', tone: 'storage' }
          : { label: 'Retired', tone: 'closed' },
        href: `/sample-storage?locationId=${encodeURIComponent(location.id)}`,
      })),
    });
  }
  if (deliveries?.ok && deliveries.data.total > 0) {
    groups.push({
      key: 'deliveries',
      title: 'Deliveries',
      total: deliveries.data.total,
      rows: deliveries.data.items.map((receipt) => ({
        key: receipt.id,
        id: receipt.project.projectNumber,
        title: `Received ${receipt.receivedDate}`,
        sub: `${plural(receipt.quantity, 'unit')} · received by ${receipt.receiver.name}`,
        tag: { label: 'Confirmed', tone: 'storage' },
        href: `/receiving-log/${encodeURIComponent(receipt.id)}`,
      })),
      more:
        deliveries.data.total > SEARCH_PREVIEW
          ? { to: `/receiving-log?search=${encoded}`, label: 'Show all in the Receiving log' }
          : undefined,
    });
  }
  if (programs?.ok && programs.data.total > 0) {
    groups.push({
      key: 'programs',
      title: 'Lab programs',
      total: programs.data.total,
      rows: programs.data.items.slice(0, SEARCH_PREVIEW).map((program) => ({
        key: program.id,
        id: program.programNumber ?? 'Draft',
        title: `${program.project.projectNumber} · ${program.project.name}`,
        sub: `${plural(program.testCount, 'test')} · requested by ${program.requestedBy.name}`,
        tag: PROGRAM_TAG[program.status],
        href: `/lab-testing/programs/${encodeURIComponent(program.id)}`,
      })),
    });
  }
  const concreteTotal = concrete?.ok ? concrete.data.total : 0;
  const total = groups.reduce((sum, group) => sum + group.total, 0) + concreteTotal;

  const shown = phone && filter !== 'all' ? groups.filter((group) => group.key === filter) : groups;
  const kinds = ['UNITS', 'PROJECTS', 'TEST HOLES', 'SHELVES', 'DELIVERIES'];
  if (FEATURES.labTesting) kinds.push('PROGRAMS');
  if (FEATURES.concreteLab) kinds.push('CONCRETE');

  return (
    <div className="search-page">
      <ContextRow align="end">
        <Link className="button" to="/sample-storage/scan">
          Scan label
        </Link>
      </ContextRow>
      <div className="search-title">
        <PageHeader
          title={loading ? 'Searching…' : total === 1 ? '1 result' : `${total} results`}
          documentTitle={false}
        />
        <p className="search-for mono" aria-live="polite">
          FOR “{q}” · {kinds.join(', ')}
        </p>
      </div>
      {phone ? (
        <Segmented label="Show" options={PHONE_FILTERS} value={filter} onChange={setFilter} />
      ) : null}
      {failures.map((failure) => (
        <ErrorState key={failure.message} message={failure.message} detail="Nothing was changed." />
      ))}
      {!loading && total === 0 && failures.length === 0 ? (
        <EmptyState title="Nothing matches.">
          No unit, project, test hole, shelf or program matches <span className="mono">“{q}”</span>.
          Check the ID, or try part of it.
        </EmptyState>
      ) : null}
      {shown.map((group) => (
        <GroupSection key={group.key} title={group.title} count={matches(group.total)}>
          <ResultList rows={group.rows} />
          {group.more ? (
            <p className="search-more">
              <Link to={group.more.to}>{group.more.label}</Link>
            </p>
          ) : null}
        </GroupSection>
      ))}
      {FEATURES.concreteLab && concrete && (!phone || filter === 'all') ? (
        concrete.ok ? (
          concreteTotal > 0 ? (
            <GroupSection title="Concrete" count={matches(concreteTotal)}>
              <ConcreteSearchResults result={concrete.data} headingLevel={3} />
              <p className="search-more">
                <Link to={`/concrete/search?q=${encoded}`}>Show all concrete results</Link>
              </p>
            </GroupSection>
          ) : null
        ) : concrete.notFound ? null : (
          <ErrorState
            message="Concrete records couldn't load. Try again."
            detail="Nothing was changed."
          />
        )
      ) : null}
      <p className="search-note">
        A scanned label that matches exactly one unit skips this page and opens the unit.
      </p>
    </div>
  );
}
