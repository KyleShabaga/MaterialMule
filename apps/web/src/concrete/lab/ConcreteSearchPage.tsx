import type { ConcreteSearch } from '@materialmule/shared';
import { ScanLine, Search, SearchX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import { DataTable, type DataTableColumn } from '../../components/strata/data-table';
import { StageTag } from '../../components/strata/stage-tag';
import { useOptionalCommandMenu } from '../../search/command-menu';
import { fetchConcreteSearch, type LoadResult } from './api';
import { fieldReportPath, setLabel, setLookupPath, specimenName } from './format';

function useConcreteSearch(q: string) {
  const [attempt, setAttempt] = useState(0);
  const key = `${q}|${attempt}`;
  const [answer, setAnswer] = useState<{ key: string; load: LoadResult<ConcreteSearch> } | null>(
    null,
  );
  useEffect(() => {
    if (!q) return;
    let current = true;
    void fetchConcreteSearch(q, 1).then((load) => current && setAnswer({ key, load }));
    return () => {
      current = false;
    };
  }, [q, key]);
  return {
    load: answer?.key === key ? answer.load : null,
    retry: () => setAttempt((n) => n + 1),
  };
}

/**
 * Concrete search (STRATA-95 part B): folded into Ctrl K and the search results page's Concrete
 * group (DESIGN.md round 7). The old page redirects there with its query; without one it opens
 * the command menu over Concrete.
 */
export function ConcreteSearchPage() {
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const commandMenu = useOptionalCommandMenu();
  useEffect(() => {
    if (!q) commandMenu?.open();
  }, [q, commandMenu]);
  return <Navigate replace to={q ? `/search?q=${encodeURIComponent(q)}` : '/concrete'} />;
}

/** One set in the lookup's results, with its field report and project. */
interface SetMatch {
  setId: string;
  name: string;
  voided: boolean;
  specimenCount: number;
  projectId: string;
  projectNumber: string;
  projectName: string;
  fieldReportId: string;
  reportDate: string | null;
  paperFieldId: string | null;
  castingDate: string | null;
}

function setMatches(result: ConcreteSearch): SetMatch[] {
  const anyMatched = result.items.some((item) => item.sets.some((s) => s.matched));
  return result.items.flatMap((item) =>
    item.sets
      .filter((s) => !anyMatched || s.matched)
      .map((s) => ({
        setId: s.setId,
        name: setLabel(s.identity),
        voided: s.voided,
        specimenCount: s.specimenCount,
        projectId: item.projectId,
        projectNumber: item.projectNumber,
        projectName: item.projectName,
        fieldReportId: item.fieldReportId,
        reportDate: item.reportDate,
        paperFieldId: item.paperFieldId,
        castingDate: item.castingDate,
      })),
  );
}

/**
 * Concrete → Specimens (STRATA-95 part B, canvas R7Specimens): type or scan a set or specimen
 * ID. One exact set match opens it; a number used in more than one project lists every match
 * with its project, and the user chooses. Ctrl K finds concrete records too.
 */
export function SpecimenLookupPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const commandMenu = useOptionalCommandMenu();
  const q = (params.get('q') ?? '').trim();
  const [text, setText] = useState(q);
  const [shownQ, setShownQ] = useState(q);
  if (shownQ !== q) {
    setShownQ(q);
    setText(q);
  }
  const { load, retry } = useConcreteSearch(q);

  const only = (() => {
    if (!load?.ok || load.data.total !== 1) return null;
    const matched = load.data.items[0]!.sets.filter((s) => s.matched);
    return matched.length === 1 && load.data.items[0]!.matches[0] === 'set_id' ? matched[0]! : null;
  })();
  useEffect(() => {
    if (only && load?.ok)
      void navigate(setLookupPath(only.setId, load.data.letter), { replace: true });
  }, [only, load, navigate]);

  const letter = load?.ok ? load.data.letter : null;
  const rows = load?.ok ? setMatches(load.data) : [];
  const projects = new Set(rows.map((r) => r.projectId)).size;

  const columns: DataTableColumn<SetMatch>[] = [
    {
      id: 'set',
      header: 'Set',
      priority: 'identity',
      width: '10rem',
      cell: (r) => (
        <Button variant="link" asChild className="h-auto p-0 font-mono font-semibold">
          <Link to={setLookupPath(r.setId, letter)}>
            {letter ? specimenName(r.name, letter) : r.name}
          </Link>
        </Button>
      ),
    },
    {
      id: 'project',
      header: 'Project',
      priority: 'identity',
      cell: (r) => (
        <span className="flex min-w-0 gap-2" title={r.projectName}>
          <span className="font-mono">{r.projectNumber}</span>
          <span className="min-w-0 truncate text-muted-foreground">{r.projectName}</span>
        </span>
      ),
    },
    {
      id: 'report',
      header: 'Field report',
      priority: 'attribute',
      hideOrder: 2,
      width: '13rem',
      cell: (r) => (
        <Button variant="link" asChild className="h-auto p-0">
          <Link to={fieldReportPath(r.fieldReportId)}>
            {r.reportDate ? <span className="font-mono">{r.reportDate}</span> : 'Field report'}
            {r.paperFieldId ? ` · Field ID ${r.paperFieldId}` : ''}
          </Link>
        </Button>
      ),
    },
    {
      id: 'cast',
      header: 'Cast',
      priority: 'attribute',
      hideOrder: 1,
      width: '10ch',
      mono: true,
      cell: (r) =>
        r.castingDate ?? <span className="font-sans text-muted-foreground">Not recorded</span>,
    },
    {
      id: 'specimens',
      header: 'Specimens',
      priority: 'attribute',
      numeric: true,
      width: '6rem',
      cell: (r) => <span className="font-mono">{r.specimenCount}</span>,
    },
    {
      id: 'state',
      header: <span className="sr-only">State</span>,
      priority: 'state',
      width: '5rem',
      cell: (r) => (r.voided ? <StageTag stage="closed" label="Void" /> : null),
    },
  ];

  return (
    <div className="@container mx-auto flex w-full max-w-[1280px] min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Specimens</h1>
        <p className="text-sm text-muted-foreground">
          Look up a set or specimen. One exact match opens it; <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> finds
          concrete records too.
        </p>
      </div>
      <form
        role="search"
        aria-label="Look up a set or specimen"
        className="flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const next = text.trim();
          if (next) void navigate(`/concrete/specimens?q=${encodeURIComponent(next)}`);
        }}
      >
        <InputGroup className="h-11 max-w-[520px] flex-1">
          <InputGroupAddon>
            <ScanLine aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Specimen or set ID"
            placeholder="Type or scan, e.g. 26-31B or TMP-D07-004"
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton type="submit" variant="secondary">
              Look up
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {commandMenu ? (
          <Button type="button" variant="outline" onClick={() => commandMenu.open(text.trim())}>
            <Search aria-hidden="true" />
            Search all concrete
          </Button>
        ) : null}
      </form>

      <section
        aria-label="Matches"
        aria-busy={Boolean(q) && load === null}
        className="flex flex-col gap-3"
      >
        {!q ? (
          <p className="text-[13px] text-muted-foreground">
            Set numbers repeat between projects, so the project is always shown with each match.
          </p>
        ) : load === null || only ? (
          <DataTable
            columns={columns}
            data={[]}
            getRowId={(r) => r.setId}
            rowLabel={(r) => r.name}
            caption="Looking up"
            loading
          />
        ) : !load.ok ? (
          <Alert variant="destructive">
            <AlertTitle>{load.message}</AlertTitle>
            <AlertDescription>
              <Button variant="outline" size="sm" onClick={retry}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchX aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No set or specimen has this ID.</EmptyTitle>
              <EmptyDescription>
                You looked up <span className="font-mono">{q}</span>. Check the marking on the
                specimen, or search by field report, ticket or casting date.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground" role="status">
              {rows.length} {rows.length === 1 ? 'set matches' : 'sets match'}{' '}
              <span className="font-mono">{q}</span> in {projects}{' '}
              {projects === 1 ? 'project' : 'projects'}.
              {projects > 1
                ? ' Set numbers repeat between projects, so the project is shown with each.'
                : ''}
            </p>
            <DataTable
              columns={columns}
              data={rows}
              getRowId={(r) => r.setId}
              rowLabel={(r) => `${r.name}, ${r.projectNumber}`}
              onOpenRow={(r) => void navigate(setLookupPath(r.setId, letter))}
              caption={`Specimen sets matching ${q}`}
            />
          </>
        )}
      </section>
    </div>
  );
}
