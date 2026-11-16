import type { RetentionPipeline, RetentionPipelineUnit } from '@materialmule/shared';
import { Gavel, ListChecks, ScanLine, Undo2, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { DataTable, type DataTableColumn } from '../components/strata/data-table';
import { StageTag } from '../components/strata/stage-tag';
import { notifyError, notifySuccess } from '../components/strata/toast';
import { announceRetentionChanged, removeFromList } from '../retention/pipeline-api';
import { approveUnits, revokeApproval } from './api';
import { BAND_INFO, retentionWords, rowTags } from './retention-rows';

type Row = RetentionPipelineUnit;

const plural = (n: number, one = 'unit', many = 'units') => `${n} ${n === 1 ? one : many}`;

function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Badge key={tag} variant="outline">
          {tag}
        </Badge>
      ))}
    </span>
  );
}

export function UnitLink({ row }: { row: Row }) {
  return (
    <Button
      variant="link"
      asChild
      className="h-auto p-0 font-mono focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring [&:hover]:underline"
    >
      <Link to={`/sample-storage/${encodeURIComponent(row.readableId)}`}>{row.readableId}</Link>
    </Button>
  );
}

const idColumn: DataTableColumn<Row> = {
  id: 'id',
  header: 'ID',
  priority: 'identity',
  mono: true,
  // 15 characters plus the stage stripe's extra left padding (it is the first cell when a table
  // has no checkbox column): IDs are never cut.
  width: '16ch',
  sortKey: 'id',
  cell: (row) => <UnitLink row={row} />,
};
const projectColumn: DataTableColumn<Row> = {
  id: 'project',
  header: 'Project',
  priority: 'identity',
  mono: true,
  width: '10ch',
  sortKey: 'project',
  cell: (row) => row.project.projectNumber,
};
const holeColumn: DataTableColumn<Row> = {
  id: 'hole',
  header: 'Test hole',
  priority: 'attribute',
  hideOrder: 2,
  cell: (row) => <span className="truncate font-mono">{row.holes.join(', ') || '—'}</span>,
};
/** At 1024 px rows drop the location column (DESIGN.md › Round 6). */
const whereColumn: DataTableColumn<Row> = {
  id: 'where',
  header: 'Where',
  priority: 'attribute',
  width: '11ch',
  hideBelow: '64rem',
  cell: (row) => <span className="truncate font-mono">{row.location.code}</span>,
};

export interface DecideTarget {
  unitIds: string[];
  context: string;
  initialChoice?: 'extend' | 'hold' | 'dispose';
}

interface ListProps {
  data: RetentionPipeline;
  today: string;
  openId: string | null;
  onOpenRow: (row: Row) => void;
  onDecide: (target: DecideTarget) => void;
  onChanged: () => void;
}

/** Coming up: three bands, then tested units (never in the bands). */
export function ComingUp({ data, today, openId, onOpenRow, onDecide }: ListProps) {
  const canDecideAny = data.rows.some((r) => r.canDecide) || data.canRequest;
  const decideLabel = data.rows.some((r) => r.canDecide) ? 'Decide' : 'Request';
  const columns = useMemo<DataTableColumn<Row>[]>(
    () => [
      idColumn,
      projectColumn,
      holeColumn,
      whereColumn,
      {
        id: 'retention',
        header: 'Retention',
        priority: 'state',
        wrap: true,
        sortKey: 'retain_until',
        cell: (row) => (
          <span className="flex flex-col gap-1">
            <span>{retentionWords(row, today)}</span>
            <Tags tags={rowTags(row)} />
          </span>
        ),
      },
      {
        id: 'decide',
        header: <span className="sr-only">Decide</span>,
        priority: 'attribute',
        control: true,
        width: '6rem',
        align: 'end',
        cell: (row) =>
          row.canDecide || data.canRequest ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={`${decideLabel} on ${row.readableId}`}
              onClick={(event) => {
                event.stopPropagation();
                onDecide({
                  unitIds: [row.storageUnitId],
                  context: `${BAND_INFO[row.band ?? 'later'].title} · ${row.project.projectNumber}`,
                });
              }}
            >
              {decideLabel}
            </Button>
          ) : null,
      },
    ],
    [today, data.canRequest, decideLabel, onDecide],
  );
  return (
    <div className="flex flex-col gap-6">
      {(['overdue', 'month', 'later'] as const).map((band) => {
        const rows = data.rows.filter((r) => r.band === band);
        const count = data.bandCounts[band];
        const headingId = `retention-band-${band}`;
        const projects = [...new Map(rows.map((r) => [r.project.id, r.project])).values()];
        return (
          <section key={band} aria-labelledby={headingId} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={headingId} className="text-base font-semibold">
                {BAND_INFO[band].title}
              </h2>
              <span className="text-muted-foreground font-mono text-sm" aria-label="Units in band">
                {count}
              </span>
              {canDecideAny && rows.length > 0 ? (
                <div className="ml-auto flex flex-wrap gap-2">
                  {projects.length > 1
                    ? projects.map((p) => (
                        <Button
                          key={p.id}
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            onDecide({
                              unitIds: rows
                                .filter((r) => r.project.id === p.id)
                                .map((r) => r.storageUnitId),
                              context: `${BAND_INFO[band].title} · ${p.projectNumber}`,
                            })
                          }
                        >
                          {decideLabel} on {p.projectNumber}
                        </Button>
                      ))
                    : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onDecide({
                        unitIds: rows.map((r) => r.storageUnitId),
                        context:
                          projects.length === 1
                            ? `${BAND_INFO[band].title} · ${projects[0]!.projectNumber}`
                            : BAND_INFO[band].title,
                      })
                    }
                  >
                    <Gavel aria-hidden="true" />
                    {decideLabel} on {plural(rows.length)}
                  </Button>
                </div>
              ) : null}
            </div>
            {rows.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing in this band.</p>
            ) : (
              <DataTable
                columns={columns}
                data={rows}
                getRowId={(row) => row.readableId}
                rowLabel={(row) => row.readableId}
                density="compact"
                stage={() => BAND_INFO[band].stage}
                onOpenRow={onOpenRow}
                openRowId={openId}
                caption={`${BAND_INFO[band].title}: retention ending`}
              />
            )}
          </section>
        );
      })}
      <TestedUnits data={data} openId={openId} onOpenRow={onOpenRow} />
    </div>
  );
}

function TestedUnits({
  data,
  openId,
  onOpenRow,
}: Pick<ListProps, 'data' | 'openId' | 'onOpenRow'>) {
  if (data.tested.length === 0) return null;
  const columns: DataTableColumn<Row>[] = [
    idColumn,
    projectColumn,
    holeColumn,
    {
      id: 'open',
      header: <span className="sr-only">Open</span>,
      priority: 'state',
      align: 'end',
      width: '8rem',
      cell: (row) => (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/sample-storage/${encodeURIComponent(row.readableId)}`}>Open unit</Link>
        </Button>
      ),
    },
  ];
  return (
    <section aria-labelledby="retention-tested" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id="retention-tested" className="text-base font-semibold">
          Tested units
        </h2>
        <span className="text-muted-foreground font-mono text-sm">{data.counts.tested}</span>
      </div>
      <p className="text-muted-foreground text-sm">
        Retention doesn’t apply. Open each unit and use “Confirm removal after testing”.
      </p>
      <DataTable
        columns={columns}
        data={data.tested}
        getRowId={(row) => row.readableId}
        rowLabel={(row) => row.readableId}
        density="compact"
        stage={() => 'storage'}
        onOpenRow={onOpenRow}
        openRowId={openId}
        caption="Tested units: removed after testing"
      />
      {data.counts.tested > data.tested.length ? (
        <p className="text-muted-foreground text-sm">
          Showing {data.tested.length} of {data.counts.tested}.
        </p>
      ) : null}
    </section>
  );
}

/** Eligible: one rule, with Add to disposal list in a selection bar. */
export function EligibleList({ data, openId, onOpenRow, onDecide }: ListProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectable = data.rows.some((r) => r.canDecide);
  const shown = data.rows.filter((r) => selected.has(r.readableId));
  const columns: DataTableColumn<Row>[] = [
    idColumn,
    projectColumn,
    holeColumn,
    whereColumn,
    {
      id: 'retain',
      header: 'Retention ended',
      priority: 'state',
      mono: true,
      width: '11ch',
      sortKey: 'retain_until',
      cell: (row) => row.effectiveRetainUntil,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Each is eligible: retain-until reached, no hold, programs closed.
      </p>
      {selectable && shown.length > 0 ? (
        <div
          role="region"
          aria-label="Selection"
          className="bg-muted flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm"
        >
          <span>{shown.length} selected</span>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() =>
              onDecide({
                unitIds: shown.map((r) => r.storageUnitId),
                context: 'Eligible',
                initialChoice: 'dispose',
              })
            }
          >
            <ListChecks aria-hidden="true" />
            Add to disposal list
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}
      <DataTable
        columns={columns}
        data={data.rows}
        getRowId={(row) => row.readableId}
        rowLabel={(row) => row.readableId}
        density="compact"
        stage={() => 'danger'}
        selectedIds={selectable ? selected : undefined}
        onSelectedIdsChange={selectable ? setSelected : undefined}
        onOpenRow={onOpenRow}
        openRowId={openId}
        caption="Eligible for disposal"
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing is eligible right now.</EmptyTitle>
              <EmptyDescription>
                Units appear here once retain-until is reached, with no hold and every program
                closed.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
    </div>
  );
}

function groupByProject(rows: Row[]) {
  const groups = new Map<string, { project: Row['project']; rows: Row[] }>();
  for (const row of rows) {
    const group = groups.get(row.project.id) ?? { project: row.project, rows: [] };
    group.rows.push(row);
    groups.set(row.project.id, group);
  }
  return [...groups.values()];
}

function ProjectHead({
  project,
  meta,
  stageLabel,
  children,
}: {
  project: Row['project'];
  meta: string;
  stageLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="text-base font-semibold">
        <span className="font-mono">{project.projectNumber}</span> {project.name}
      </h2>
      <span className="text-muted-foreground text-sm">
        {project.lead ? `Lead ${project.lead.name}` : 'Waiting for a lead'} · {meta}
      </span>
      <StageTag stage="due" label={stageLabel} />
      <div className="ml-auto flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/** A reason dialog (remove from the list, revoke approval): reason required. */
function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  ids,
  confirm,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  ids: string[];
  confirm: string;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setReason('');
          setTried(false);
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-40 overflow-y-auto font-mono text-sm">
          {ids.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
        <Field data-invalid={tried && !reason.trim()}>
          <FieldLabel htmlFor="retention-reason-dialog">Reason (required)</FieldLabel>
          <Textarea
            id="retention-reason-dialog"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {tried && !reason.trim() ? (
            <FieldError>Give a reason. It’s recorded in each unit’s history.</FieldError>
          ) : null}
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              setTried(true);
              if (!reason.trim()) return;
              setBusy(true);
              void onConfirm(reason.trim()).finally(() => {
                setBusy(false);
                setReason('');
                setTried(false);
              });
            }}
          >
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** On disposal list: grouped by project with the lead; Approve n units; Remove (reason). */
export function DisposalListTab({ data, openId, onOpenRow, onChanged }: ListProps) {
  const [approving, setApproving] = useState<Row['project'] | null>(null);
  const [removing, setRemoving] = useState<Row[] | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const groups = groupByProject(data.rows);
  const approvingRows = approving ? data.rows.filter((r) => r.project.id === approving.id) : [];

  async function approve() {
    const rows = approvingRows.filter((r) => r.canApprove);
    const outcome = await approveUnits(
      rows.map((r) => r.storageUnitId),
      key,
    );
    setKey(crypto.randomUUID());
    setApproving(null);
    if (outcome.ok) {
      notifySuccess(`${plural(rows.length)} approved for disposal.`, {
        description: 'Scan them out at the shelf to dispose of them.',
      });
      announceRetentionChanged();
    } else notifyError('Not approved.', outcome.message);
    onChanged();
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-sm">
        Approval doesn’t dispose anything; the units stay in stock until scanned out.
      </p>
      {groups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>The disposal list is empty.</EmptyTitle>
            <EmptyDescription>
              Add eligible units from Eligible or with Decide; a lead then approves them here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {groups.map(({ project, rows }) => {
        const canApprove = rows.some((r) => r.canApprove);
        const columns: DataTableColumn<Row>[] = [
          idColumn,
          holeColumn,
          whereColumn,
          {
            id: 'retain',
            header: 'Retain until',
            priority: 'attribute',
            mono: true,
            width: '11ch',
            cell: (row) => row.effectiveRetainUntil,
          },
          {
            id: 'added',
            header: 'Added',
            priority: 'state',
            wrap: true,
            cell: (row) => (
              <span className="flex flex-col">
                <span>
                  {row.listEntry?.addedBy.name ?? '—'}{' '}
                  <span className="text-muted-foreground font-mono">
                    {row.listEntry?.addedAt.slice(0, 10)}
                  </span>
                </span>
                {row.listEntry?.reason ? (
                  <span
                    className="text-muted-foreground truncate text-xs"
                    title={row.listEntry.reason}
                  >
                    {row.listEntry.reason}
                  </span>
                ) : null}
                {row.blockers.length > 0 ? (
                  <span className="text-destructive text-xs">
                    Now blocked: {row.blockers.map((b) => b.label).join('; ')}
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            id: 'remove',
            header: <span className="sr-only">Remove</span>,
            priority: 'attribute',
            control: true,
            width: '3rem',
            align: 'end',
            cell: (row) =>
              row.canApprove ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${row.readableId} from the disposal list`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setRemoving([row]);
                  }}
                >
                  <X aria-hidden="true" />
                </Button>
              ) : null,
          },
        ];
        return (
          <section
            key={project.id}
            aria-label={`Disposal list ${project.projectNumber}`}
            className="flex flex-col gap-2"
          >
            <ProjectHead project={project} meta={plural(rows.length)} stageLabel="Due · Approval">
              {canApprove ? (
                <Button size="sm" onClick={() => setApproving(project)}>
                  Approve {plural(rows.length)}
                </Button>
              ) : project.lead ? null : (
                <span className="text-muted-foreground text-sm">
                  Approval waits for a confirmed lead.
                </span>
              )}
            </ProjectHead>
            <DataTable
              columns={columns}
              data={rows}
              getRowId={(row) => row.readableId}
              rowLabel={(row) => row.readableId}
              density="compact"
              stage={() => 'due'}
              onOpenRow={onOpenRow}
              openRowId={openId}
              caption={`On the disposal list: ${project.projectNumber}`}
            />
          </section>
        );
      })}
      <AlertDialog open={approving !== null} onOpenChange={(open) => !open && setApproving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Approve {plural(approvingRows.length)} of {approving?.projectNumber} for disposal?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Material Mule checks each one again: retain-until reached, no hold, every program
              closed. Approval doesn’t dispose anything; the units stay in stock until scanned out.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-40 overflow-y-auto font-mono text-sm">
            {approvingRows.map((r) => (
              <li key={r.storageUnitId}>
                {r.readableId} · retain until {r.effectiveRetainUntil}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void approve()}>Approve</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ReasonDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Take ${plural(removing?.length ?? 0)} off the disposal list?`}
        description="They go back to Coming up or Eligible. Nothing is disposed."
        ids={(removing ?? []).map((r) => r.readableId)}
        confirm="Take off the list"
        onConfirm={async (reason) => {
          const rows = removing ?? [];
          const result = await removeFromList(
            rows.map((r) => r.storageUnitId),
            reason,
            crypto.randomUUID(),
          );
          setRemoving(null);
          if (result.ok) {
            notifySuccess(`${plural(result.data.removed.length)} taken off the disposal list.`);
            announceRetentionChanged();
          } else notifyError('Not taken off the list.', result.message);
          onChanged();
        }}
      />
    </div>
  );
}

/** Approved (waiting for the scan): grouped by project; leads revoke with a reason. */
export function ApprovedTab({ data, openId, onOpenRow, onChanged }: ListProps) {
  const [revoking, setRevoking] = useState<Row[] | null>(null);
  const groups = groupByProject(data.rows);
  const columns: DataTableColumn<Row>[] = [
    idColumn,
    holeColumn,
    whereColumn,
    {
      id: 'waiting',
      header: 'Waiting for',
      priority: 'state',
      wrap: true,
      cell: (row) =>
        row.blockers.length > 0 ? (
          <span className="text-destructive">
            Blocked: {row.blockers.map((b) => b.label).join('; ')}
          </span>
        ) : (
          'The scan at the shelf'
        ),
    },
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted-foreground text-sm">
          Approval doesn’t dispose anything; the units stay in stock until scanned out.
        </p>
        <Button size="sm" variant="outline" className="ml-auto" asChild>
          <Link to="/disposal-retention/scan">
            <ScanLine aria-hidden="true" />
            Start disposal scan
          </Link>
        </Button>
      </div>
      {groups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing is approved for disposal.</EmptyTitle>
            <EmptyDescription>
              When a lead approves units on the disposal list, they appear here, ready for the scan
              at the shelf.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" asChild>
              <Link to="/disposal-retention?tab=list">Open the disposal list</Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}
      {groups.map(({ project, rows }) => {
        const approval = rows.find((r) => r.approval)?.approval;
        const canRevoke = rows.filter((r) => r.canApprove && r.approval);
        return (
          <section
            key={project.id}
            aria-label={`Approved ${project.projectNumber}`}
            className="flex flex-col gap-2"
          >
            <ProjectHead
              project={project}
              meta={
                approval
                  ? `Approved by ${approval.approvedBy.name} on ${approval.approvedAt.slice(0, 10)}`
                  : plural(rows.length)
              }
              stageLabel="Due · Disposal scan"
            >
              {canRevoke.length > 0 ? (
                <Button size="sm" variant="outline" onClick={() => setRevoking(canRevoke)}>
                  <Undo2 aria-hidden="true" />
                  Revoke approval
                </Button>
              ) : null}
            </ProjectHead>
            <DataTable
              columns={columns}
              data={rows}
              getRowId={(row) => row.readableId}
              rowLabel={(row) => row.readableId}
              density="compact"
              stage={() => 'due'}
              onOpenRow={onOpenRow}
              openRowId={openId}
              caption={`Approved, waiting for the scan: ${project.projectNumber}`}
            />
          </section>
        );
      })}
      <ReasonDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke approval for ${plural(revoking?.length ?? 0)} of ${revoking?.[0]?.project.projectNumber ?? ''}?`}
        description="They go back on the disposal list to wait for approval. Nothing is disposed, and nothing has left the shelf."
        ids={(revoking ?? []).map((r) => r.readableId)}
        confirm={`Revoke approval for ${plural(revoking?.length ?? 0)}`}
        onConfirm={async (reason) => {
          const rows = revoking ?? [];
          const problems: string[] = [];
          for (const row of rows) {
            const outcome = await revokeApproval(row.approval!.id, reason, crypto.randomUUID());
            if (!outcome.ok) problems.push(`${row.readableId}: ${outcome.message}`);
          }
          setRevoking(null);
          if (problems.length === 0) {
            notifySuccess(`Approval revoked for ${plural(rows.length)}.`);
          } else notifyError('Some approvals weren’t revoked.', problems.join(' '));
          announceRetentionChanged();
          onChanged();
        }}
      />
    </div>
  );
}

/** Disposed: read-only history; each keeps its ID. */
export function DisposedTab({ data, openId, onOpenRow }: ListProps) {
  const columns: DataTableColumn<Row>[] = [
    idColumn,
    projectColumn,
    holeColumn,
    {
      id: 'disposed',
      header: 'Disposed',
      priority: 'state',
      mono: true,
      width: '11ch',
      cell: (row) => row.disposal?.disposedAt?.slice(0, 10) ?? '—',
    },
    {
      id: 'by',
      header: 'Scanned out by',
      priority: 'attribute',
      hideOrder: 1,
      cell: (row) =>
        row.disposal?.route === 'tested'
          ? `${row.disposal.disposedBy?.name ?? '—'} (after testing)`
          : (row.disposal?.disposedBy?.name ?? '—'),
    },
    {
      id: 'approved',
      header: 'Approved by',
      priority: 'attribute',
      hideOrder: 2,
      cell: (row) => row.approval?.approvedBy.name ?? '—',
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Read-only. Each disposed unit keeps its ID and history.
      </p>
      <DataTable
        columns={columns}
        data={data.rows}
        getRowId={(row) => row.readableId}
        rowLabel={(row) => row.readableId}
        density="compact"
        stage={() => 'closed'}
        onOpenRow={onOpenRow}
        openRowId={openId}
        caption="Disposed units"
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing has been disposed yet.</EmptyTitle>
            </EmptyHeader>
          </Empty>
        }
      />
    </div>
  );
}

export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Retention couldn’t load.</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
