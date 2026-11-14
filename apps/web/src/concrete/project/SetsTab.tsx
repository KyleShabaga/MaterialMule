import {
  CONCRETE_PROJECT_SET_STATUS_LABEL,
  type ConcreteProjectSetRow,
  type ProjectDetail,
} from '@materialmule/shared';
import { Cylinder } from 'lucide-react';
import { useId, useMemo, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  DataTable,
  DENSITY_VIEW_OPTIONS,
  useTableDensity,
  type DataTableColumn,
} from '../../components/strata/data-table';
import { StageTag } from '../../components/strata/stage-tag';
import { TableToolbar } from '../../components/strata/table-toolbar';
import { useTableQuery, type TableQuery } from '../../components/strata/table-query';
import { StrengthReportList } from '../../concrete-review/StrengthReportList';
import { useDebounced } from '../../projects/project-format';
import { LoadErrorAlert, TablePager } from '../../projects/project-ui';
import { concreteProblem, fetchProjectSets } from './api';
import { SET_STAGE, ageText } from './concrete-format';
import { setPath } from './paths';
import { ConcreteNote, ConcreteSection, TestedProgress } from './ui';
import { useLoad } from './useLoad';

// STRATA-98 Sets sub-tab (canvas R8ProjectSets): each specimen set with its test ages and "n of m
// tested". Sets show working labels (Set 2, specimens 2A–2D) until permanent set numbering is
// decided (package 3); the label is derived by the server, never stored. A row opens the set page.
// The project's strength reports (one per set, C39) are listed under the sets.

const PAGE_SIZE = 25;

function identityText(row: ConcreteProjectSetRow): string | null {
  return row.identity.permanentId ?? row.identity.temporaryId;
}

export function SetsTab({ project }: { project: ProjectDetail }) {
  const headingId = useId();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const [density, setDensity] = useTableDensity('concrete-project-sets');
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const search = useDebounced(query.search).trim();
  const { load, reload } = useLoad(`${project.id}|${search}|${page}`, () =>
    fetchProjectSets(project.id, { search, page }),
  );
  const today = load.state === 'ready' ? load.data.today : null;

  const columns = useMemo<DataTableColumn<ConcreteProjectSetRow>[]>(
    () => [
      {
        id: 'set',
        header: 'Set',
        priority: 'identity',
        width: '12rem',
        cell: (row) => {
          const id = identityText(row);
          return (
            <span className="flex min-w-0 flex-col">
              <Button
                variant="link"
                asChild
                className="h-auto justify-start p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid [&:hover]:underline"
              >
                <Link to={setPath(row.setId)} aria-label={`Open ${row.workingLabel}`}>
                  {row.workingLabel}
                </Link>
              </Button>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {[row.specimenRange, id].filter(Boolean).join(' · ')}
              </span>
            </span>
          );
        },
      },
      {
        id: 'cast',
        header: 'Cast',
        priority: 'attribute',
        mono: true,
        width: '11ch',
        hideOrder: 2,
        cell: (row) => row.castingDate ?? '—',
      },
      {
        id: 'structure',
        header: 'Structure / element',
        priority: 'identity',
        wrap: true,
        cell: (row) => row.structure.join(', ') || row.location || '—',
      },
      {
        id: 'ages',
        header: 'Test ages',
        priority: 'attribute',
        mono: true,
        hideOrder: 3,
        cell: (row) => row.testAges.map(ageText).join(', ') || '—',
      },
      {
        id: 'tested',
        header: 'Tested',
        priority: 'state',
        width: '8rem',
        control: true,
        cell: (row) => <TestedProgress tested={row.testedCount} scheduled={row.scheduledCount} />,
      },
      {
        id: 'status',
        header: 'Status',
        priority: 'state',
        width: '10rem',
        cell: (row) => (
          <StageTag
            stage={SET_STAGE[row.status]}
            label={CONCRETE_PROJECT_SET_STATUS_LABEL[row.status]}
          />
        ),
      },
      {
        id: 'next',
        header: 'Next break',
        priority: 'attribute',
        mono: true,
        width: '11ch',
        hideOrder: 1,
        cell: (row) =>
          row.nextTestDate ? (row.nextTestDate === today ? 'Today' : row.nextTestDate) : '—',
      },
    ],
    [today],
  );

  const toolbarQuery: TableQuery = { ...query, view: density };
  const onQueryChange = (patch: Partial<TableQuery>) => {
    const { view, ...rest } = patch;
    if (view === 'comfortable' || view === 'compact') setDensity(view);
    if (Object.keys(rest).length > 0) setQuery(rest);
  };

  let body: ReactNode;
  if (load.state === 'error') {
    body = (
      <LoadErrorAlert
        title={`Couldn’t load the concrete records for ${project.projectNumber}`}
        message={concreteProblem(load.error)}
        onRetry={reload}
      />
    );
  } else if (load.state === 'ready' && load.data.total === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Cylinder aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {search ? 'No sets match this search.' : 'No specimen sets for this project yet.'}
          </EmptyTitle>
          {search ? null : (
            <EmptyDescription>
              A set is listed here once a field report records the specimens it cast.
            </EmptyDescription>
          )}
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <>
        <DataTable
          columns={columns}
          data={load.state === 'ready' ? load.data.items : []}
          getRowId={(row) => row.setId}
          rowLabel={(row) => row.workingLabel}
          density={density}
          stage={(row) => SET_STAGE[row.status]}
          onOpenRow={(row) => navigate(setPath(row.setId))}
          caption={`Specimen sets, ${project.projectNumber}`}
          loading={load.state === 'loading'}
        />
        {load.state === 'ready' ? (
          <TablePager
            page={load.data.page}
            pageSize={PAGE_SIZE}
            total={load.data.total}
            noun={load.data.total === 1 ? 'set' : 'sets'}
            onPage={(next) =>
              setParams((current) => {
                const out = new URLSearchParams(current);
                if (next > 1) out.set('page', String(next));
                else out.delete('page');
                return out;
              })
            }
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <ConcreteSection
        id={headingId}
        title="Sets"
        tools={
          <TableToolbar
            label="Sets tools"
            query={toolbarQuery}
            onQueryChange={onQueryChange}
            views={DENSITY_VIEW_OPTIONS}
            searchPlaceholder="Search sets…"
          />
        }
      >
        <div aria-busy={load.state === 'loading'} className="min-w-0">
          {body}
        </div>
        <ConcreteNote>
          Sets show their working labels: permanent set numbering is an open item (package 3). HOLD
          specimens wait for a scheduled test and aren’t counted in “n of m”. Rows open the set
          page.
        </ConcreteNote>
      </ConcreteSection>
      {/* MM-V2-C39: one strength report per specimen set, cumulative. */}
      <ConcreteSection id={`${headingId}-strength`} title="Strength reports">
        <StrengthReportList
          projectId={project.id}
          caption="Strength reports"
          empty="No strength reports for this project yet. A set appears once its results are entered."
        />
      </ConcreteSection>
    </div>
  );
}
