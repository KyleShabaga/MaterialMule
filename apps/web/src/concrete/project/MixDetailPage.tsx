import type {
  ConcreteMixChange,
  ConcreteMixDetail,
  ConcreteMixRevision,
  ConcreteMixSpec,
} from '@materialmule/shared';
import {
  Check,
  CircleAlert,
  Ellipsis,
  GitCompareArrows,
  Link as LinkIcon,
  Lock,
  Pencil,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
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
import { PersonAvatar } from '../../components/strata/person-avatar';
import { StageTag } from '../../components/strata/stage-tag';
import { STAGE_MARK_BG } from '../../components/strata/stage';
import { notifyError, notifySuccess } from '../../components/strata/toast';
import { copyText } from '../../projects/project-format';
import { LoadErrorAlert } from '../../projects/project-ui';
import {
  ConcreteApiError,
  approveMix,
  concreteProblem,
  fetchMix,
  fetchPropagation,
  updateMix,
} from './api';
import { MIX_STAGE, dateTime } from './concrete-format';
import { MixForm, type MixSpecInput } from './MixForm';
import { DiscardDraftDialog, SupplierLink } from './MixManage';
import { admixturesText, airText, slumpText, strengthText, value } from './mix-format';
import { ConcreteRecordFrame } from './ProjectConcretePage';
import { concreteTabPath, mixPath, propagationPath } from './paths';
import { useLoad } from './useLoad';

// MM-V2-C30, STRATA-98: one mix (canvas R8Mix*): the revision in effect and any draft side by side
// with the draft's changes marked, the supplier-ticket defaults, every revision and the history.
// Only the project's Lead edits (D14: an approved mix gets a draft revision, "Edit as a new
// revision") and approves; the controls follow the server's `canManage` / `canApprove`, and the
// server refuses everyone else. After an approval the Lead chooses which existing records take
// the new values (propagation). MM-V2-C37's discard draft and listed-supplier link live here too.

const ACTION_LABEL: Record<string, string> = {
  'concrete_mix.created': 'Created',
  'concrete_mix.copied': 'Copied from another project',
  'concrete_mix.draft_edited': 'Draft edited',
  'concrete_mix.revision_drafted': 'Revision drafted',
  'concrete_mix.approved': 'Approved',
  'concrete_mix.draft_discarded': 'Draft discarded',
  'concrete_mix.supplier_linked': 'Listed supplier changed',
  'concrete_mix.propagation_applied': 'Records updated from the mix',
};

interface SpecRow {
  key: string;
  label: string;
  value: string;
  mono?: boolean;
}

/** One revision's specification as labelled rows, in the same order for every revision. */
function specRows(spec: ConcreteMixSpec): SpecRow[] {
  return [
    { key: 'supplier', label: 'Supplier', value: spec.supplierName },
    { key: 'number', label: 'Mix number', value: spec.mixNumber, mono: true },
    {
      key: 'plants',
      label: 'Plants',
      value: spec.plantNames.length > 0 ? spec.plantNames.join(', ') : '—',
    },
    {
      key: 'strength',
      label: 'Strength',
      value: value(spec.specifiedStrengthMpa, ' MPa'),
      mono: true,
    },
    {
      key: 'strengthAge',
      label: 'Strength age',
      value: value(spec.specifiedStrengthAgeDays, ' d'),
      mono: true,
    },
    { key: 'slump', label: 'Slump', value: slumpText(spec), mono: true },
    { key: 'air', label: 'Air', value: airText(spec), mono: true },
    {
      key: 'aggregate',
      label: 'Max aggregate',
      value: value(spec.maxAggregateSizeMm, ' mm'),
      mono: true,
    },
    { key: 'cement', label: 'Cement type', value: spec.cementType ?? 'Not entered' },
    { key: 'admixtures', label: 'Admixtures', value: admixturesText(spec.specAdmixtures) },
    {
      key: 'ages',
      label: 'Test ages',
      value: spec.testAges.map(String).join(' · ') || '—',
      mono: true,
    },
  ];
}

/** The supplier-ticket defaults (field form only) as labelled rows. */
function ticketRows(spec: ConcreteMixSpec): SpecRow[] {
  const t = spec.ticketDefaults;
  return [
    {
      key: 't-strength',
      label: 'Strength on ticket',
      value: value(t.specifiedStrengthMpa, ' MPa'),
      mono: true,
    },
    { key: 't-slump', label: 'Slump on ticket', value: slumpText(t), mono: true },
    { key: 't-air', label: 'Air on ticket', value: airText(t), mono: true },
    {
      key: 't-aggregate',
      label: 'Max aggregate on ticket',
      value: value(t.maxAggregateSizeMm, ' mm'),
      mono: true,
    },
    { key: 't-cement', label: 'Cement on ticket', value: t.cementType ?? '—' },
    { key: 't-admixtures', label: 'Admixtures on ticket', value: admixturesText(t.admixtures) },
  ];
}

const revisionColumn = (revision: ConcreteMixRevision) =>
  `Revision ${revision.revisionNumber}, ${revision.state === 'draft' ? 'draft' : 'in effect'}`;

/**
 * The specification as a table: one column per revision shown (the one in effect, then the
 * draft). A draft value that differs from the one in effect is tinted and marked "changed".
 */
function SpecTable({
  label,
  rows,
  first,
  draft,
}: {
  label: string;
  rows: (spec: ConcreteMixSpec) => SpecRow[];
  /** The revision in effect, else the only (draft) revision. */
  first: ConcreteMixRevision;
  /** The draft beside the revision in effect, when there is one. */
  draft: ConcreteMixRevision | null;
}) {
  const left = rows(first.spec);
  const right = draft ? rows(draft.spec) : null;
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-40">Field</TableHead>
          <TableHead>{revisionColumn(first)}</TableHead>
          {draft ? <TableHead>{revisionColumn(draft)}</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {left.map((row, i) => {
          const next = right?.[i];
          const changed = next !== undefined && next.value !== row.value;
          return (
            <TableRow key={row.key}>
              <TableCell className="text-muted-foreground">{row.label}</TableCell>
              <TableCell className={row.mono ? 'font-mono whitespace-normal' : 'whitespace-normal'}>
                {row.value}
              </TableCell>
              {next ? (
                <TableCell
                  data-changed={changed ? 'true' : undefined}
                  className={`whitespace-normal ${changed ? 'bg-stage-due-bg font-semibold text-stage-due-fg' : ''}`}
                >
                  <span className={next.mono ? 'font-mono' : undefined}>{next.value}</span>
                  {changed ? <span className="text-xs font-normal">, changed</span> : null}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function changedLabels(first: ConcreteMixSpec, draft: ConcreteMixSpec): string[] {
  const before = specRows(first);
  return specRows(draft)
    .filter((row, i) => before[i]?.value !== row.value)
    .map((row) => row.label.toLowerCase());
}

const REVISION_TAG: Record<ConcreteMixRevision['state'], ReactNode> = {
  draft: <StageTag stage="draft" label="Draft" />,
  approved: <StageTag stage="storage" label="In effect" />,
  superseded: <StageTag stage="closed" label="Superseded" />,
  discarded: <StageTag stage="closed" label="Discarded" />,
};

function revisionLine(revision: ConcreteMixRevision): string {
  if (revision.state === 'discarded' && revision.discardedAt) {
    return `Discarded ${revision.discardedAt.slice(0, 10)}${revision.discardedBy ? ` by ${revision.discardedBy.name}` : ''}`;
  }
  if (revision.approvedAt) {
    return `Approved ${revision.approvedAt.slice(0, 10)}${revision.approvedBy ? ` by ${revision.approvedBy.name}` : ''}`;
  }
  return `${revision.createdBy.name} · ${revision.createdAt.slice(0, 10)}`;
}

export function MixDetailPage() {
  const { projectId = '', mixId = '' } = useParams();
  return <MixLoader projectId={projectId} mixId={mixId} />;
}

function MixLoader({ projectId, mixId }: { projectId: string; mixId: string }) {
  const { load, reload, replace } = useLoad(`mix|${mixId}`, () => fetchMix(mixId));
  // The mix is loaded by ID alone: under another project's address it goes to its own project, so
  // its content and controls never show under the wrong project header.
  if (load.state === 'ready' && load.data.projectId !== projectId) {
    return <Navigate replace to={mixPath(load.data.projectId, load.data.id)} />;
  }
  const mixNumber = load.state === 'ready' ? load.data.mixNumber : 'Mix';
  return (
    <ConcreteRecordFrame
      projectId={projectId}
      title={load.state === 'ready' ? `Mix ${mixNumber}` : 'Mix'}
      crumbs={[
        { label: 'Mixes', to: concreteTabPath(projectId, 'mixes') },
        { label: mixNumber, mono: load.state === 'ready' },
      ]}
    >
      {() =>
        load.state === 'loading' ? (
          <div aria-busy="true" className="flex flex-col gap-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-64 w-full" />
            <p className="sr-only" role="status">
              Loading…
            </p>
          </div>
        ) : load.state === 'error' ? (
          <LoadErrorAlert
            title="This mix couldn't load"
            message={concreteProblem(load.error)}
            onRetry={reload}
          />
        ) : (
          <MixDetail mix={load.data} replace={replace} />
        )
      }
    </ConcreteRecordFrame>
  );
}

function MixDetail({
  mix,
  replace,
}: {
  mix: ConcreteMixDetail;
  replace: (next: ConcreteMixDetail) => void;
}) {
  const navigate = useNavigate();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = MIX_STAGE[mix.status];
  const effective = mix.effectiveRevision;
  const draft = mix.draftRevision;
  const first = effective ?? draft;
  const beside = effective && draft ? draft : null;
  const working = draft ?? effective;
  const changes = effective && draft ? changedLabels(effective.spec, draft.spec) : null;
  const isLead = mix.canManage || mix.canApprove;
  const missing = draft?.missingForApproval ?? [];
  const canApproveDraft = mix.canApprove && draft !== null;

  const stale = (caught: unknown) => {
    if (caught instanceof ConcreteApiError && caught.code === 'version_conflict') {
      const current = (caught.body as { current?: ConcreteMixDetail } | null)?.current;
      if (current) replace(current);
    }
    setError(concreteProblem(caught));
  };

  function managed(next: ConcreteMixDetail, message: string) {
    replace(next);
    setDiscarding(false);
    setError(null);
    notifySuccess(message);
  }

  function save(spec: Partial<MixSpecInput>) {
    setBusy(true);
    setError(null);
    updateMix(mix.id, { idempotencyKey: crypto.randomUUID(), version: mix.version, spec })
      .then((next) => {
        replace(next);
        setEditing(false);
        notifySuccess(
          effective
            ? `Saved as draft revision ${next.draftRevision?.revisionNumber ?? ''}. Revision ${effective.revisionNumber} stays in effect until you approve it.`
            : 'Draft saved.',
        );
      })
      .catch(stale)
      .finally(() => setBusy(false));
  }

  function approve() {
    if (!draft) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    approveMix(mix.id, {
      idempotencyKey: crypto.randomUUID(),
      version: mix.version,
      revisionId: draft.id,
    })
      .then(async (next) => {
        replace(next);
        notifySuccess(`Revision ${draft.revisionNumber} approved.`);
        // Records made from earlier revisions: the Lead decides which change (propagation).
        const preview = await fetchPropagation(next.id).catch(() => null);
        if (preview && preview.items.length > 0) navigate(propagationPath(mix.projectId, next.id));
      })
      .catch(stale)
      .finally(() => setBusy(false));
  }

  const primaryHint = canApproveDraft
    ? effective
      ? `Revision ${effective.revisionNumber} stays in effect until you approve revision ${draft.revisionNumber}.`
      : `Approving makes revision ${draft.revisionNumber} the one field reports use.`
    : mix.canManage && effective
      ? `Your changes are saved as a new revision. Revision ${effective.revisionNumber} stays in effect until you approve it.`
      : null;

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <span
            aria-hidden="true"
            className={`w-1 shrink-0 self-stretch rounded-full ${STAGE_MARK_BG[status.stage]}`}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm text-muted-foreground">
              Mix · {mix.supplierName} · <span className="font-mono">{mix.projectNumber}</span>
            </p>
            <h1 className="font-mono text-[28px] leading-[34px] font-bold">{mix.mixNumber}</h1>
            {first ? <p className="font-mono text-sm">{strengthText(first.spec)}</p> : null}
            {mix.copiedFrom ? (
              <p className="text-sm text-muted-foreground">
                Copied from {mix.copiedFrom.projectNumber} {mix.copiedFrom.supplierName}{' '}
                {mix.copiedFrom.mixNumber}, revision {mix.copiedFrom.revisionNumber}.
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex max-w-md flex-col items-start gap-3 @3xl:items-end">
          <div role="group" aria-label="Mix status" className="flex flex-wrap items-center gap-2">
            <StageTag stage={status.stage} label={status.label} />
            {effective ? (
              <Badge variant="outline">Revision {effective.revisionNumber} in effect</Badge>
            ) : null}
          </div>
          {isLead && !editing ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {canApproveDraft ? (
                  <Button disabled={busy || missing.length > 0} onClick={() => setConfirming(true)}>
                    <Check aria-hidden="true" />
                    Approve revision {draft.revisionNumber}
                  </Button>
                ) : mix.canManage ? (
                  <Button disabled={busy} onClick={() => setEditing(true)}>
                    <Pencil aria-hidden="true" />
                    Change this mix
                  </Button>
                ) : null}
                {mix.canManage && draft ? (
                  <Button
                    variant={canApproveDraft ? 'outline' : 'default'}
                    disabled={busy}
                    onClick={() => setEditing(true)}
                  >
                    <Pencil aria-hidden="true" />
                    Edit draft
                  </Button>
                ) : null}
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="More actions">
                      <Ellipsis aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    {mix.canApprove && effective ? (
                      <DropdownMenuItem asChild>
                        <Link to={propagationPath(mix.projectId, mix.id)}>
                          <GitCompareArrows aria-hidden="true" />
                          Review affected records
                        </Link>
                      </DropdownMenuItem>
                    ) : null}
                    {mix.canManage && draft && effective ? (
                      <DropdownMenuItem variant="destructive" onSelect={() => setDiscarding(true)}>
                        <Trash2 aria-hidden="true" />
                        Discard draft revision {draft.revisionNumber}
                      </DropdownMenuItem>
                    ) : null}
                    {(mix.canApprove && effective) || (mix.canManage && draft && effective) ? (
                      <DropdownMenuSeparator />
                    ) : null}
                    <DropdownMenuItem
                      onSelect={() => {
                        const url = `${window.location.origin}${mixPath(mix.projectId, mix.id)}`;
                        void copyText(url).then((copied) =>
                          copied
                            ? notifySuccess('Link copied')
                            : notifyError("Couldn't copy the link. Copy it from the address bar."),
                        );
                      }}
                    >
                      <LinkIcon aria-hidden="true" />
                      Copy link
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {missing.length > 0 && canApproveDraft ? (
                <p className="text-[13px] text-muted-foreground">
                  Before approval, fill in: {missing.join(', ')}.
                </p>
              ) : primaryHint ? (
                <p className="text-[13px] text-muted-foreground @3xl:text-right">{primaryHint}</p>
              ) : null}
              {mix.canManage && draft && !effective ? (
                <p className="text-[13px] text-muted-foreground @3xl:text-right">
                  This mix has no approved revision yet, so its draft can&rsquo;t be discarded.
                </p>
              ) : null}
            </>
          ) : null}
          {!isLead ? (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Lock aria-hidden="true" className="size-3.5" />
              Only the project’s lead changes mixes. You can see every revision.
            </p>
          ) : null}
        </div>
      </header>

      {!effective ? (
        <Alert>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>This mix has no approved revision yet</AlertTitle>
          <AlertDescription>
            Field reports that pick it are flagged for review as an unapproved mix. Approving needs
            strength, slump, air, max aggregate and cement.
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-8 @4xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-8">
          {editing && working ? (
            <section aria-labelledby={`${id}-edit`} className="flex flex-col gap-3">
              <h2 id={`${id}-edit`} className="text-lg font-semibold">
                {draft ? `Edit draft revision ${draft.revisionNumber}` : 'Edit as a new revision'}
              </h2>
              <MixForm
                initial={working.spec}
                title="Edit mix"
                submitLabel="Save draft"
                busy={busy}
                error={null}
                onCancel={() => setEditing(false)}
                onSubmit={save}
              />
            </section>
          ) : null}

          {first ? (
            <section aria-labelledby={`${id}-spec`} className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 id={`${id}-spec`} className="text-lg font-semibold">
                  Specification
                </h2>
                {changes ? (
                  <span className="text-sm text-muted-foreground">
                    {changes.length === 0
                      ? 'The draft has the same values'
                      : `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} in the draft: ${changes.join(', ')}`}
                  </span>
                ) : null}
              </div>
              <SpecTable label="Mix specification" rows={specRows} first={first} draft={beside} />
            </section>
          ) : null}

          {first ? (
            <section aria-labelledby={`${id}-ticket`} className="flex min-w-0 flex-col gap-3">
              <h2 id={`${id}-ticket`} className="text-lg font-semibold">
                Supplier-ticket defaults
              </h2>
              <SpecTable
                label="Supplier-ticket defaults"
                rows={ticketRows}
                first={first}
                draft={beside}
              />
              <p className="text-[13px] text-muted-foreground">
                Defaults for the field form only. They never show that a ticket was checked.
              </p>
            </section>
          ) : null}

          <section aria-labelledby={`${id}-revs`} className="flex flex-col gap-3">
            <h2 id={`${id}-revs`} className="text-lg font-semibold">
              Revisions
            </h2>
            <ItemGroup className="gap-2">
              {mix.revisions.map((revision) => (
                <Item key={revision.id} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>Revision {revision.revisionNumber}</ItemTitle>
                    <ItemDescription>{revisionLine(revision)}</ItemDescription>
                  </ItemContent>
                  <ItemActions>{REVISION_TAG[revision.state]}</ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </section>

          {effective && draft ? (
            <section aria-labelledby={`${id}-records`} className="flex flex-col gap-2">
              <h2 id={`${id}-records`} className="text-lg font-semibold">
                Records made from revision {effective.revisionNumber}
              </h2>
              <p className="text-sm">
                Approving revision {draft.revisionNumber} changes none of them by itself: you then
                choose which records to update.
              </p>
            </section>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-8">
          <section aria-labelledby={`${id}-history`} className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2">
              <h2 id={`${id}-history`} className="text-lg font-semibold">
                History
              </h2>
              <span className="text-sm text-muted-foreground">
                {mix.historyTotal} {mix.historyTotal === 1 ? 'event' : 'events'}
              </span>
            </div>
            <ItemGroup aria-label="History, newest first" className="gap-1">
              {mix.history.map((event) => (
                <HistoryItem key={event.id} event={event} />
              ))}
            </ItemGroup>
          </section>
          <section aria-labelledby={`${id}-supplier`} className="flex flex-col gap-3">
            <h2 id={`${id}-supplier`} className="text-lg font-semibold">
              Supplier
            </h2>
            <SupplierLink key={mix.version} mix={mix} onDone={managed} />
          </section>
          <section aria-labelledby={`${id}-doc`} className="flex flex-col gap-2">
            <h2 id={`${id}-doc`} className="text-lg font-semibold">
              Mix design document
            </h2>
            <p className="text-[13px] text-muted-foreground">
              Attaching the supplier’s mix design document arrives with file storage (C15).
            </p>
          </section>
        </div>
      </div>

      {discarding && draft && effective ? (
        <DiscardDraftDialog mix={mix} onDone={managed} onCancel={() => setDiscarding(false)} />
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve revision {draft?.revisionNumber ?? ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              New field reports and specimen sets will use this revision. Existing records keep
              their values until you review them on the next screen.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={approve}>Approve</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function HistoryItem({ event }: { event: ConcreteMixChange }) {
  const who = event.changedBy?.name ?? 'Material Mule';
  return (
    <Item size="sm" className="items-start px-0">
      <ItemMedia>
        <PersonAvatar name={who} userId={event.changedBy?.userId} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex-wrap">{ACTION_LABEL[event.action] ?? event.action}</ItemTitle>
        <ItemDescription>
          {who} · {dateTime(event.occurredAt)}
        </ItemDescription>
        {event.action === 'concrete_mix.propagation_applied' ? (
          <p className="text-[13px]">
            {event.after.scope === 'approve_all' ? 'Approve all' : 'Chosen records'} from revision{' '}
            {String(event.after.toRevision)}:{' '}
            {Array.isArray(event.after.applied) ? event.after.applied.join('; ') : ''}
          </p>
        ) : null}
        {event.note ? (
          <p className="text-[13px] text-muted-foreground">Note: {event.note}</p>
        ) : null}
      </ItemContent>
    </Item>
  );
}
