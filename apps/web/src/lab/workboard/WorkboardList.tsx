import { WORKBOARD_COLUMN_TAG, type WorklistItem } from '@materialmule/shared';
import { Link, useNavigate } from 'react-router';
import { DataTable, type DataTableColumn } from '@/components/strata/data-table';
import { StageTag } from '@/components/strata/stage-tag';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { openAge } from '../format';
import { UrgentTag } from './ProgramCard';
import { programHref, progressOf } from './program-facts';

const COLUMNS: readonly DataTableColumn<WorklistItem>[] = [
  {
    id: 'program',
    header: 'Program',
    priority: 'identity',
    mono: true,
    width: '13ch',
    cell: (item) => (
      <Button
        asChild
        variant="link"
        className="h-auto p-0 font-mono text-[13px] font-semibold whitespace-nowrap text-foreground"
      >
        <Link to={programHref(item)} onClick={(event) => event.stopPropagation()}>
          {item.programNumber}
        </Link>
      </Button>
    ),
  },
  {
    id: 'project',
    header: 'Project',
    priority: 'identity',
    cell: (item) => (
      <span className="flex min-w-0 gap-2">
        <span className="shrink-0 font-mono">{item.project.projectNumber}</span>
        <span className="truncate text-muted-foreground">{item.project.name}</span>
      </span>
    ),
  },
  {
    id: 'priority',
    header: 'Priority',
    priority: 'attribute',
    hideOrder: 3,
    width: '10rem',
    control: true,
    cell: (item) =>
      item.priority === 'urgent' ? (
        <UrgentTag />
      ) : (
        <span className="text-muted-foreground">Normal</span>
      ),
  },
  {
    id: 'progress',
    header: 'Progress',
    priority: 'attribute',
    hideOrder: 2,
    width: '9rem',
    cell: (item) => {
      const { done, total, percent } = progressOf(item);
      return (
        <span className="flex items-center gap-2">
          <Progress
            value={percent}
            aria-label={`${done} of ${total} tests done`}
            className="h-1.5 w-16 shrink-0"
          />
          <span className="tabular-nums">
            {done} of {total}
          </span>
        </span>
      );
    },
  },
  {
    id: 'oldest',
    header: 'Oldest open',
    priority: 'attribute',
    hideOrder: 1,
    width: '8rem',
    cell: (item) => (item.oldestOpenSeconds === null ? '—' : openAge(item.oldestOpenSeconds)),
  },
  {
    id: 'status',
    header: 'Status',
    priority: 'state',
    width: '12rem',
    wrap: true,
    cell: (item) => {
      const tag = WORKBOARD_COLUMN_TAG[item.column];
      return <StageTag stage={tag.stage} label={tag.label} />;
    },
  },
];

/**
 * The list view (STRATA-88): the same programs as the board in one table, in the toolbar's order
 * (priority then oldest open by default), searched and filtered on the server.
 */
export function WorkboardList({ items, empty }: { items: WorklistItem[]; empty: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <div role="region" aria-label="Workboard table" tabIndex={0}>
      <DataTable
        caption="Workboard"
        columns={COLUMNS}
        data={items}
        getRowId={(item) => item.programId}
        rowLabel={(item) => item.programNumber}
        stage={(item) => WORKBOARD_COLUMN_TAG[item.column].stage}
        onOpenRow={(item) => void navigate(programHref(item))}
        empty={empty}
      />
    </div>
  );
}
