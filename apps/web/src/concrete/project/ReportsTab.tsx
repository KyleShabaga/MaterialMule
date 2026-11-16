import type { ConcreteFieldReportSummary, ProjectDetail } from '@materialmule/shared';
import { FilePlus, FileText } from 'lucide-react';
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
import { PersonCell } from '../../components/strata/person-avatar';
import { StageTag } from '../../components/strata/stage-tag';
import { TableToolbar } from '../../components/strata/table-toolbar';
import { useTableQuery, type TableQuery } from '../../components/strata/table-query';
import { useDebounced } from '../../projects/project-format';
import { LoadErrorAlert, TablePager } from '../../projects/project-ui';
import { useMe } from '../../session/context';
import { concreteProblem, fetchProjectReports } from './api';
import {
  REPORT_STATUS_FILTERS,
  keepOneStatus,
  reportReview,
  reportStatus,
  reportStatusQuery,
} from './concrete-format';
import { structureText } from './mix-format';
import { fieldReportPath } from './paths';
import { ConcreteNote, ConcreteSection } from './ui';
import { useLoad } from './useLoad';

// MM-V2-C30, STRATA-98 Field reports sub-tab (canvas R8ProjectReports): each report's date,
// structure / element, technician, status, where it stands in review and its Field ID. A row opens
// the report page. Technicians draft, submit and correct reports as they do today; there is no
// field form here yet, so New field report stays off.

const PAGE_SIZE = 25;
const FILTERS = [...REPORT_STATUS_FILTERS, { id: 'mine', label: 'Mine' }];
const STATUS_IDS = new Set<string>(REPORT_STATUS_FILTERS.map((f) => f.id));

export function ReportsTab({ project }: { project: ProjectDetail }) {
  const headingId = useId();
  const navigate = useNavigate();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const [density, setDensity] = useTableDensity('concrete-project-reports');
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const search = useDebounced(query.search).trim();
  const status = query.filters.find((id) => STATUS_IDS.has(id)) ?? null;
  const mine = query.filters.includes('mine');

  const { load, reload } = useLoad(
    `${project.id}|${search}|${status ?? ''}|${mine ? me.id : ''}|${page}`,
    () =>
      fetchProjectReports(project.id, {
        search,
        ...reportStatusQuery(status),
        ...(mine ? { technicianUserId: me.id } : {}),
        page,
      }),
  );

  const columns = useMemo<DataTableColumn<ConcreteFieldReportSummary>[]>(
    () => [
      {
        id: 'date',
        header: 'Report date',
        priority: 'identity',
        mono: true,
        width: '11ch',
        cell: (row) => (
          <Button
            variant="link"
            asChild
            className="h-auto p-0 font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid [&:hover]:underline"
          >
            <Link
              to={fieldReportPath(row.id)}
              aria-label={`Open field report ${row.reportDate ?? 'with no date'}`}
            >
              {row.reportDate ?? 'No date'}
            </Link>
          </Button>
        ),
      },
      {
        id: 'structure',
        header: 'Structure / element',
        priority: 'identity',
        wrap: true,
        cell: (row) =>
          structureText(row.locationElements, row.locationElementOther) ||
          row.locationDescription ||
          '—',
      },
      {
        id: 'technician',
        header: 'Technician',
        priority: 'attribute',
        hideOrder: 2,
        cell: (row) =>
          row.technician ? (
            <PersonCell name={row.technician.name} userId={row.technician.userId} />
          ) : (
            '—'
          ),
      },
      {
        id: 'status',
        header: 'Status',
        priority: 'state',
        width: '13rem',
        wrap: true,
        cell: (row) => {
          const tag = reportStatus(row);
          return <StageTag stage={tag.stage} label={tag.label} />;
        },
      },
      {
        id: 'review',
        header: 'Review',
        priority: 'attribute',
        hideOrder: 1,
        wrap: true,
        cell: (row) => <span className="text-muted-foreground">{reportReview(row)}</span>,
      },
      {
        id: 'fieldId',
        header: 'Field ID',
        priority: 'attribute',
        mono: true,
        hideOrder: 3,
        cell: (row) => row.paperFieldId ?? '—',
      },
    ],
    [],
  );

  const toolbarQuery: TableQuery = { ...query, view: density };
  const onQueryChange = (patch: Partial<TableQuery>) => {
    const { view, ...rest } = patch;
    if (view === 'comfortable' || view === 'compact') setDensity(view);
    if (rest.filters) rest.filters = keepOneStatus(rest.filters);
    if (Object.keys(rest).length > 0) setQuery(rest);
  };
  const filtered = Boolean(search || query.filters.length > 0);

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
            <FileText aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {filtered
              ? 'No field reports match these filters.'
              : 'No field reports for this project yet.'}
          </EmptyTitle>
          {filtered ? null : (
            <EmptyDescription>
              Technicians start field reports; each one is listed here with its review state.
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
          getRowId={(row) => row.id}
          rowLabel={(row) => `Field report ${row.reportDate ?? 'with no date'}`}
          density={density}
          stage={(row) => reportStatus(row).stage}
          onOpenRow={(row) => navigate(fieldReportPath(row.id))}
          caption={`Field reports, ${project.projectNumber}`}
          loading={load.state === 'loading'}
        />
        {load.state === 'ready' ? (
          <TablePager
            page={load.data.page}
            pageSize={PAGE_SIZE}
            total={load.data.total}
            noun={load.data.total === 1 ? 'report' : 'reports'}
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
    <ConcreteSection
      id={headingId}
      title="Field reports"
      tools={
        <TableToolbar
          label="Field reports tools"
          query={toolbarQuery}
          onQueryChange={onQueryChange}
          pageAction={{
            label: 'New field report (the field form is not built yet)',
            icon: FilePlus,
            onClick: () => undefined,
            disabled: true,
          }}
          filters={FILTERS}
          views={DENSITY_VIEW_OPTIONS}
          searchPlaceholder="Search field reports…"
        />
      }
    >
      <div aria-busy={load.state === 'loading'} className="min-w-0">
        {body}
      </div>
      <ConcreteNote>
        Technicians draft, submit and correct field reports as they do today. Offline field entry
        and final reports are not built yet (open items). Rows open the report page.
      </ConcreteNote>
    </ConcreteSection>
  );
}
