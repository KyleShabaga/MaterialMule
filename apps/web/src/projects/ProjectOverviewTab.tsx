import {
  formatDepthRanges,
  formatSampleRange,
  type InventoryItem,
  type LabProgramSummary,
  type ProjectDetail,
} from '@materialmule/shared';
import { ChevronRight, Clock, Copy, Info, Plus } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { createTestHole } from '../api/projects';
import { PersonCell } from '../components/strata/person-avatar';
import { StageTag } from '../components/strata/stage-tag';
import { STAGE_MARK_BG } from '../components/strata/stage';
import { notifyError, notifySuccess } from '../components/strata/toast';
import { FEATURES } from '../features';
import { fetchInventory } from '../inventory/api';
import { ProjectRetentionSection } from '../retention/RetentionSections';
import { addDays, businessToday } from '../retention/bands';
import { useMe } from '../session/context';
import { fetchProjectPrograms } from './api';
import {
  copyText,
  daysBetween,
  holeUnitsPath,
  programName,
  programStage,
  programStatusLabel,
  relativeDays,
} from './project-format';
import { useProjectLayout } from './project-layout-context';
import { OverviewSection, ProgramProgress } from './project-ui';

/** Test holes shown before "Show all n test holes". */
const HOLES_SHOWN = 6;
/** Recent receipts on the Overview; the rest are in the receiving log. */
const RECEIPTS_SHOWN = 5;
/** Retention coming up: units whose retention ends within this many days (or already has). */
const RETENTION_WINDOW_DAYS = 30;
const RETENTION_SHOWN = 5;
const PROGRAMS_SHOWN = 5;

/**
 * The project's Overview (STRATA-84, canvas R4Overview*): 2:1 at wide widths, Test holes and
 * Recent receipts on the left, Retention coming up and Lab programs on the right; under 56rem the
 * sections stack. Project-wide holds and retention requests follow (MM-T29, `#retention`).
 */
export function ProjectOverviewTab() {
  const { project, reloadProject } = useProjectLayout();
  const me = useMe();
  const canReadTeam = me.permissions.includes('project_access.read');
  const personal = me.accountType !== 'shared_lab';
  const noAssignment =
    personal && project.involvement !== undefined && project.involvement.length === 0;

  return (
    <div className="flex flex-col gap-6">
      {!project.leadProjectEngineer ? (
        <Alert className="relative overflow-hidden">
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-stage-due-mark" />
          <Clock aria-hidden="true" />
          <AlertTitle>Waiting for a Lead Project Engineer</AlertTitle>
          <AlertDescription>
            <p>
              Receiving works as usual. Closing programs, approving disposal and managing the team
              wait until an admin appoints a lead.
              {project.leadNomination
                ? ` ${project.leadNomination.nominatedBy.name} nominated ${project.leadNomination.nominee.name} on ${project.leadNomination.nominatedAt.slice(0, 10)}.`
                : ''}
            </p>
            {canReadTeam ? (
              <div className="mt-2">
                <Button variant="outline" size="sm" className="text-foreground" asChild>
                  <Link to={`/projects/${encodeURIComponent(project.id)}/team`}>
                    Open Team &amp; permissions
                  </Link>
                </Button>
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {noAssignment ? (
        <Alert>
          <Info aria-hidden="true" />
          <AlertTitle>You have no assignment on this project. You can still see it.</AlertTitle>
          {project.leadProjectEngineer ? (
            <AlertDescription>
              <p>{project.leadProjectEngineer.displayName} leads it.</p>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 @min-[56rem]:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 @min-[56rem]:col-span-2">
          <TestHolesSection
            project={project}
            canAdd={me.permissions.includes('test_hole.create')}
            onAdded={reloadProject}
          />
          <RecentReceipts project={project} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          {FEATURES.disposalRetention ? <RetentionComingUp project={project} /> : null}
          {FEATURES.labTesting && me.permissions.includes('lab_program.read') ? (
            <LabProgramsSummary project={project} />
          ) : null}
          <ProjectDetails project={project} />
        </div>
      </div>

      {/* MM-T29: project-wide holds, extensions and requests (action requests link to #retention). */}
      <ProjectRetentionSection projectId={project.id} onChanged={reloadProject} />
    </div>
  );
}

function TestHolesSection({
  project,
  canAdd,
  onAdded,
}: {
  project: ProjectDetail;
  canAdd: boolean;
  onAdded: () => void;
}) {
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const holes = project.testHoles;
  const shown = showAll ? holes : holes.slice(0, HOLES_SHOWN);
  return (
    <OverviewSection
      id="overview-holes"
      title="Test holes"
      meta={<span className="font-mono">{holes.length}</span>}
      action={
        canAdd ? (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            Add test hole
          </Button>
        ) : null
      }
    >
      {holes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No test holes yet.</p>
      ) : (
        <>
          <Table aria-label="Test holes">
            <TableHeader>
              <TableRow>
                <TableHead>Test hole</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead>SAMPLE#</TableHead>
                <TableHead>Depth</TableHead>
                <TableHead className="w-8">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((hole) => {
                const samples = formatSampleRange(hole.sampleRange, hole.allSamples);
                const depth = formatDepthRanges(hole.depthRanges);
                const to = holeUnitsPath(project.id, hole.id);
                return (
                  <TableRow
                    key={hole.id}
                    className="cursor-pointer"
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest('a')) return;
                      navigate(to);
                    }}
                  >
                    <TableCell>
                      <Button variant="link" asChild className="h-auto p-0 font-mono">
                        <Link to={to} aria-label={`${hole.name}: open its storage units`}>
                          {hole.name}
                        </Link>
                      </Button>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {hole.unitCount}
                    </TableCell>
                    <TableCell
                      className={hole.unitCount === 0 ? 'text-muted-foreground' : 'font-mono'}
                    >
                      {hole.unitCount === 0 ? 'No units yet' : (samples ?? '—')}
                    </TableCell>
                    <TableCell className="font-mono whitespace-nowrap">{depth ?? '—'}</TableCell>
                    <TableCell>
                      <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>A hole opens its units in Storage units.</span>
            {holes.length > HOLES_SHOWN ? (
              <Button variant="link" className="h-auto p-0" onClick={() => setShowAll((v) => !v)}>
                {showAll ? `Show the first ${HOLES_SHOWN}` : `Show all ${holes.length} test holes`}
              </Button>
            ) : null}
          </div>
        </>
      )}
      <AddTestHoleDialog
        open={adding}
        projectId={project.id}
        onOpenChange={setAdding}
        onAdded={(name) => {
          setAdding(false);
          notifySuccess(`Added test hole ${name}`);
          onAdded();
        }}
      />
    </OverviewSection>
  );
}

function AddTestHoleDialog({
  open,
  projectId,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  projectId: string;
  onOpenChange: (open: boolean) => void;
  onAdded: (name: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === '') {
      setError('Test hole name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createTestHole(projectId, { name });
      if (result.kind === 'created') {
        setName('');
        onAdded(result.record.name);
      } else if (result.kind === 'exists') {
        setError(`${result.existing.name} already exists in this project.`);
      } else {
        setError(result.fieldErrors.name?.[0] ?? 'Check the test hole name.');
      }
    } catch {
      setError("Couldn't add the test hole. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName('');
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form aria-label="Add test hole" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Add test hole</DialogTitle>
            <DialogDescription>
              Names are kept exactly as typed, and must be new in this project.
            </DialogDescription>
          </DialogHeader>
          <Field className="my-4" data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={id}>Test hole name</FieldLabel>
            <Input
              id={id}
              value={name}
              maxLength={40}
              autoComplete="off"
              placeholder="e.g. TH26-03"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => setName(event.target.value)}
            />
            {error ? (
              <FieldError id={`${id}-error`} role="alert">
                {error}
              </FieldError>
            ) : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Add test hole
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RecentReceipts({ project }: { project: ProjectDetail }) {
  const receipts = project.receipts.slice(0, RECEIPTS_SHOWN);
  return (
    <OverviewSection
      id="overview-receipts"
      title="Recent receipts"
      meta={project.receiptCount > RECEIPTS_SHOWN ? `Last ${RECEIPTS_SHOWN}` : undefined}
      action={
        project.receiptCount > 0 ? (
          <Button variant="link" asChild className="h-auto p-0">
            <Link to={`/receiving-log?projectId=${encodeURIComponent(project.id)}`}>
              Open the receiving log
            </Link>
          </Button>
        ) : null
      }
    >
      {receipts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing received for this project yet.</p>
      ) : (
        <ItemGroup aria-label="Recent receipts" role="list">
          {receipts.map((receipt) => (
            <Item key={receipt.id} size="sm" role="listitem" className="px-0">
              <ItemContent>
                <ItemTitle>
                  <Button variant="link" asChild className="h-auto p-0">
                    <Link to={`/receiving-log/${encodeURIComponent(receipt.id)}`}>
                      {receipt.unitCount} {receipt.unitCount === 1 ? 'unit' : 'units'} on{' '}
                      <span className="font-mono">{receipt.receivedDate}</span>
                    </Link>
                  </Button>
                </ItemTitle>
                {receipt.testHoleNames && receipt.testHoleNames.length > 0 ? (
                  <ItemDescription className="font-mono">
                    {receipt.testHoleNames.join(', ')}
                  </ItemDescription>
                ) : null}
              </ItemContent>
              <ItemActions>
                <PersonCell name={receipt.receiver.name} userId={receipt.receiver.userId} />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </OverviewSection>
  );
}

function RetentionComingUp({ project }: { project: ProjectDetail }) {
  const today = businessToday();
  const [items, setItems] = useState<
    { key: string; ok: true; items: InventoryItem[] } | { key: string; ok: false } | null
  >(null);
  const key = `${project.id}:${project.inStockUnitCount}:${today}`;
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      projectId: project.id,
      status: 'in_stock',
      retainUntilTo: addDays(today, RETENTION_WINDOW_DAYS),
      sort: 'retain_until',
      pageSize: String(RETENTION_SHOWN * 2),
    });
    void fetchInventory(params).then((response) => {
      if (cancelled) return;
      setItems(
        response.ok
          ? {
              key,
              ok: true,
              // A unit on hold isn't due for a decision.
              items: response.data.items
                .filter((item) => !item.retention?.onHold)
                .slice(0, RETENTION_SHOWN),
            }
          : { key, ok: false },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [key, project.id, today]);
  const current = items?.key === key ? items : null;

  return (
    <OverviewSection id="overview-retention" title="Retention coming up" meta="Next 30 days">
      {!current ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !current.ok ? (
        <p className="text-sm text-muted-foreground">
          Retention couldn't load. Reload to try again.
        </p>
      ) : current.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No unit's retention ends in the next 30 days.
        </p>
      ) : (
        <ItemGroup aria-label="Retention coming up" role="list">
          {current.items.map((item) => {
            const ends = item.retention?.effectiveRetainUntil ?? '';
            const overdue = ends !== '' && daysBetween(today, ends) <= 0;
            return (
              <Item key={item.id} size="sm" role="listitem" className="relative px-0 pl-3">
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-1 left-0 w-1 rounded-full ${
                    STAGE_MARK_BG[overdue ? 'danger' : 'due']
                  }`}
                />
                <ItemContent>
                  <ItemTitle>
                    <Button variant="link" asChild className="h-auto p-0 font-mono">
                      <Link to={`/sample-storage/${encodeURIComponent(item.readableId)}`}>
                        {item.readableId}
                      </Link>
                    </Button>
                  </ItemTitle>
                  <ItemDescription>
                    {overdue ? 'Ended ' : 'Ends '}
                    <span className="font-mono">{ends}</span> · {relativeDays(today, ends)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button variant="outline" size="sm" asChild>
                    <Link
                      to={`/sample-storage/${encodeURIComponent(item.readableId)}#retention`}
                      aria-label={`Decide on ${item.readableId}`}
                    >
                      Decide
                    </Link>
                  </Button>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
      <Button variant="link" asChild className="h-auto self-start p-0">
        <Link to={`/disposal-retention?projectId=${encodeURIComponent(project.id)}`}>
          Open Retention for this project
        </Link>
      </Button>
    </OverviewSection>
  );
}

function LabProgramsSummary({ project }: { project: ProjectDetail }) {
  const counts = project.labProgramCounts ?? { open: 0, closed: 0 };
  const [programs, setPrograms] = useState<{
    key: string;
    items: LabProgramSummary[] | null;
  } | null>(null);
  const key = `${project.id}:${counts.open}:${counts.closed}`;
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      projectId: project.id,
      status: 'submitted',
      pageSize: String(PROGRAMS_SHOWN),
    });
    void fetchProjectPrograms(params).then((response) => {
      if (!cancelled) setPrograms({ key, items: response.ok ? response.data.items : null });
    });
    return () => {
      cancelled = true;
    };
  }, [key, project.id]);
  const current = programs?.key === key ? programs : null;
  const programsPath = `/projects/${encodeURIComponent(project.id)}/programs`;

  return (
    <OverviewSection
      id="overview-programs"
      title="Lab programs"
      meta={`${counts.open} open · ${counts.closed} closed`}
    >
      {!current ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-12 w-full" />
        </div>
      ) : current.items === null ? (
        <p className="text-sm text-muted-foreground">
          Lab programs couldn't load. Reload to try again.
        </p>
      ) : current.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open lab programs.</p>
      ) : (
        <ItemGroup aria-label="Open lab programs" role="list">
          {current.items.map((program) => (
            <Item key={program.id} size="sm" role="listitem" className="px-0">
              <ItemContent>
                <ItemTitle className="flex flex-wrap items-center gap-2">
                  <Button variant="link" asChild className="h-auto p-0 font-mono">
                    <Link to={`/lab-testing/programs/${encodeURIComponent(program.id)}`}>
                      {programName(program)}
                    </Link>
                  </Button>
                  <StageTag stage={programStage(program)} label={programStatusLabel(program)} />
                </ItemTitle>
                <div className="text-sm text-muted-foreground">
                  <ProgramProgress program={program} />
                </div>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      {counts.open + counts.closed > 0 ? (
        <Button variant="link" asChild className="h-auto self-start p-0">
          <Link to={programsPath}>Open Lab programs</Link>
        </Button>
      ) : null}
    </OverviewSection>
  );
}

/** Client and the server folder (copyable text: browsers block file:// links). */
function ProjectDetails({ project }: { project: ProjectDetail }) {
  return (
    <OverviewSection id="overview-details" title="Project details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Client</dt>
        <dd className="min-w-0 break-words">{project.client}</dd>
        <dt className="text-muted-foreground">Server folder</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-2">
          {project.serverFolderPath ? (
            <>
              <code className="min-w-0 font-mono text-xs break-all">
                {project.serverFolderPath}
              </code>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  void copyText(project.serverFolderPath ?? '').then((copied) =>
                    copied
                      ? notifySuccess('Folder path copied')
                      : notifyError("Couldn't copy. Select the path and copy it."),
                  );
                }}
              >
                <Copy aria-hidden="true" />
                Copy
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground">Not set</span>
          )}
        </dd>
      </dl>
    </OverviewSection>
  );
}
