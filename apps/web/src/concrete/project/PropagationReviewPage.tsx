import {
  CONCRETE_MIX_PROPAGATION_FIELD_LABEL,
  CONCRETE_MIX_PROPAGATION_INELIGIBLE_LABEL,
  type ConcreteMixPropagationChange,
  type ConcreteMixPropagationItem,
  type ConcreteMixPropagationPreview,
} from '@materialmule/shared';
import {
  ArrowLeft,
  Check,
  CircleAlert,
  CircleCheck,
  GitCompareArrows,
  Lock,
  Minus,
  RefreshCw,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadErrorAlert } from '../../projects/project-ui';
import { ConcreteApiError, applyPropagation, concreteProblem, fetchPropagation } from './api';
import { propagationGroup } from './concrete-format';
import { propagationValue } from './mix-format';
import { fieldReportPath, concreteTabPath, mixPath, propagationPath } from './paths';
import { ConcreteRecordFrame } from './ProjectConcretePage';
import { useLoad } from './useLoad';

// MM-V2-C30, STRATA-98: the Lead's change propagation (canvas R8Prop*). After a revision is
// approved, existing reports and untested specimen schedules made from an earlier revision are
// listed in three groups from the server's eligibility: Can be updated (chosen), Your call
// (updatable, but a value changed by hand there is kept; not chosen) and Won't change (with why
// it stays). Nothing changes until the Lead applies chosen records or Approve all; the apply is
// version-safe (a list that changed since it was shown is refused, and reloaded). The note is
// kept in the mix history.

const fieldLabel = (field: string) => CONCRETE_MIX_PROPAGATION_FIELD_LABEL[field] ?? field;

function ChangeList({ changes }: { changes: ConcreteMixPropagationChange[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {changes.map((change) => (
        <li key={change.field} className="text-[13px]">
          <span className="text-muted-foreground">{fieldLabel(change.field)}</span>{' '}
          <span className="font-mono">
            <span className="sr-only">from </span>
            <s className="text-muted-foreground">
              {propagationValue(change.field, change.before)}
            </s>{' '}
            <span aria-hidden="true" className="before:content-['→']" />{' '}
            <span className="sr-only">to </span>
            <strong>{propagationValue(change.field, change.proposed)}</strong>
          </span>
        </li>
      ))}
    </ul>
  );
}

function RecordTitle({ item }: { item: ConcreteMixPropagationItem }) {
  return (
    <ItemTitle className="flex-wrap">
      <Button
        variant="link"
        asChild
        className="h-auto p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid [&:hover]:underline"
      >
        <Link to={fieldReportPath(item.fieldReportId)}>{item.recordLabel}</Link>
      </Button>
      <span className="text-xs font-normal text-muted-foreground">
        from revision {item.fromRevisionNumber ?? '—'}
      </span>
    </ItemTitle>
  );
}

/** Distinct value changes across the listed records, for the summary badges under the title. */
function changeSummary(items: ConcreteMixPropagationItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    for (const change of item.changes) {
      seen.add(
        `${fieldLabel(change.field)} ${propagationValue(change.field, change.before)} → ${propagationValue(change.field, change.proposed)}`,
      );
    }
  }
  return [...seen].slice(0, 6);
}

export function PropagationReviewPage() {
  const { projectId = '', mixId = '' } = useParams();
  const { load, reload, replace } = useLoad(`propagation|${mixId}`, () => fetchPropagation(mixId));
  // As the mix page: under another project's address, go to the mix's own project.
  if (load.state === 'ready' && load.data.projectId !== projectId) {
    return <Navigate replace to={propagationPath(load.data.projectId, load.data.mixId)} />;
  }
  const mixNumber = load.state === 'ready' ? load.data.mixNumber : 'Mix';
  return (
    <ConcreteRecordFrame
      projectId={projectId}
      title="Update records"
      crumbs={[
        { label: 'Mixes', to: concreteTabPath(projectId, 'mixes') },
        { label: mixNumber, to: mixPath(projectId, mixId), mono: load.state === 'ready' },
        { label: 'Update records' },
      ]}
    >
      {() =>
        load.state === 'loading' ? (
          <div aria-busy="true" className="flex flex-col gap-3">
            <Skeleton className="h-8 w-80" />
            <Skeleton className="h-48 w-full" />
            <p className="sr-only" role="status">
              Loading…
            </p>
          </div>
        ) : load.state === 'error' ? (
          <LoadErrorAlert
            title="The records to update couldn't load"
            message={concreteProblem(load.error)}
            onRetry={reload}
          />
        ) : (
          <PropagationReview
            projectId={projectId}
            preview={load.data}
            replace={replace}
            reload={reload}
          />
        )
      }
    </ConcreteRecordFrame>
  );
}

function PropagationReview({
  projectId,
  preview,
  replace,
  reload,
}: {
  projectId: string;
  preview: ConcreteMixPropagationPreview;
  replace: (next: ConcreteMixPropagationPreview) => void;
  reload: () => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState<{ previewId: string; ids: Set<string> } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ count: number; revision: number | null } | null>(null);
  const [stale, setStale] = useState<{ current: ConcreteMixPropagationPreview | null } | null>(
    null,
  );
  const [confirmAll, setConfirmAll] = useState(false);

  const mixLink = mixPath(projectId, preview.mixId);
  if (preview.toRevisionNumber === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitCompareArrows aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            <h1>This mix has no approved revision yet, so there is nothing to update.</h1>
          </EmptyTitle>
          <EmptyDescription>
            Records are listed here after the lead approves a revision that changes values they were
            made with.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" asChild>
            <Link to={mixLink}>
              <ArrowLeft aria-hidden="true" />
              Back to the mix
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const groups = {
    can: preview.items.filter((i) => propagationGroup(i) === 'can'),
    call: preview.items.filter((i) => propagationGroup(i) === 'call'),
    wont: preview.items.filter((i) => propagationGroup(i) === 'wont'),
  };
  const eligible = [...groups.can, ...groups.call];
  const selected =
    choice?.previewId === preview.previewId ? choice.ids : new Set(groups.can.map((i) => i.itemId));
  const chosen = eligible.filter((i) => selected.has(i.itemId));
  const canDecide = preview.canApply && eligible.length > 0;
  const blocked = busy || stale !== null;
  const summary = changeSummary(eligible.length > 0 ? eligible : preview.items);

  function toggle(itemId: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(itemId);
    else next.delete(itemId);
    setChoice({ previewId: preview.previewId, ids: next });
  }

  function decide(selection: 'items' | 'approve_all') {
    setBusy(true);
    setError(null);
    setApplied(null);
    setConfirmAll(false);
    applyPropagation(preview.mixId, {
      idempotencyKey: crypto.randomUUID(),
      previewId: preview.previewId,
      selection:
        selection === 'items'
          ? { kind: 'items', itemIds: chosen.map((i) => i.itemId) }
          : { kind: 'approve_all', displayedItemIds: preview.items.map((i) => i.itemId) },
      note: note.trim() || null,
    })
      .then((result) => {
        replace(result.preview);
        setChoice(null);
        setNote('');
        setApplied({ count: result.appliedItemIds.length, revision: preview.toRevisionNumber });
      })
      .catch((caught: unknown) => {
        if (caught instanceof ConcreteApiError && caught.code === 'preview_stale') {
          const current =
            (caught.body as { current?: ConcreteMixPropagationPreview } | null)?.current ?? null;
          setStale({ current });
          return;
        }
        setError(concreteProblem(caught));
      })
      .finally(() => setBusy(false));
  }

  function reloadList() {
    if (stale?.current) replace(stale.current);
    else reload();
    setStale(null);
    setChoice(null);
    setError(null);
  }

  const checkbox = (item: ConcreteMixPropagationItem) =>
    preview.canApply ? (
      <ItemMedia>
        <Checkbox
          aria-label={`Update ${item.recordLabel}`}
          checked={selected.has(item.itemId)}
          disabled={stale !== null}
          onCheckedChange={(on) => toggle(item.itemId, on === true)}
        />
      </ItemMedia>
    ) : null;

  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">
          Update records from revision {preview.toRevisionNumber}
        </h1>
        <p className="max-w-3xl text-sm">
          Revision {preview.toRevisionNumber} of{' '}
          <span className="font-mono">{preview.mixNumber}</span> ({preview.supplierName}) is in
          effect. These records were made from earlier revisions. Nothing changes until you apply.
          Measured results, the supplier-ticket column, IDs and completed tests never change.
        </p>
        {summary.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {summary.map((text) => (
              <Badge key={text} variant="outline" className="font-mono">
                {text}
              </Badge>
            ))}
          </div>
        ) : null}
      </header>

      {stale ? (
        <Alert>
          <RefreshCw aria-hidden="true" />
          <AlertTitle>This list changed since it was shown</AlertTitle>
          <AlertDescription>
            <p>
              A record changed after this list was shown, so it may no longer be updated as listed.
              Reload the list before applying; nothing has been applied.
            </p>
            <div className="mt-2">
              <Button variant="outline" size="sm" onClick={reloadList}>
                <RefreshCw aria-hidden="true" />
                Reload the list
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {applied ? (
        <Alert>
          <CircleCheck aria-hidden="true" />
          <AlertTitle>
            Applied to {applied.count} {applied.count === 1 ? 'record' : 'records'}
          </AlertTitle>
          <AlertDescription>
            Each record’s history names revision {applied.revision}, and your note is kept in the
            mix history. The records under Your call and Won’t change were left as they were, unless
            you chose them.
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}
      {!preview.canApply && preview.items.length > 0 ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Lock aria-hidden="true" className="size-3.5" />
          Only the project’s Lead Project Engineer can update records from the mix.
        </p>
      ) : null}
      {preview.items.length === 0 ? (
        <p className="text-sm">
          Every report and schedule already uses revision {preview.toRevisionNumber}.
        </p>
      ) : null}
      {preview.truncated ? (
        <p className="text-[13px] text-muted-foreground">
          More records are affected than listed. Decide on these, then review again.
        </p>
      ) : null}

      {groups.can.length > 0 ? (
        <Group
          id={`${id}-can`}
          title="Can be updated"
          count={groups.can.length}
          hint={
            preview.canApply
              ? 'Chosen. Untick any you want to leave.'
              : 'These records can take the new values.'
          }
        >
          {groups.can.map((item) => (
            <Item key={item.itemId} variant="outline" size="sm" className="items-start">
              {checkbox(item)}
              <ItemContent>
                <RecordTitle item={item} />
                <ChangeList changes={item.changes} />
              </ItemContent>
            </Item>
          ))}
        </Group>
      ) : null}

      {groups.call.length > 0 ? (
        <Group
          id={`${id}-call`}
          title="Your call"
          count={groups.call.length}
          hint="Not chosen. Each has a value someone changed by hand, which is kept."
        >
          {groups.call.map((item) => (
            <Item key={item.itemId} variant="outline" size="sm" className="items-start">
              {checkbox(item)}
              <ItemContent>
                <RecordTitle item={item} />
                <ChangeList changes={item.changes} />
                <ItemDescription className="mt-1">
                  Changed by hand, kept as written:
                </ItemDescription>
                <ChangeList changes={item.kept} />
              </ItemContent>
            </Item>
          ))}
        </Group>
      ) : null}

      {groups.wont.length > 0 ? (
        <Group
          id={`${id}-wont`}
          title="Won’t change"
          count={groups.wont.length}
          hint="Listed so you can see why."
        >
          {groups.wont.map((item) => (
            <Item key={item.itemId} variant="outline" size="sm" className="items-start">
              <ItemMedia>
                <Minus aria-hidden="true" className="size-4 text-muted-foreground" />
              </ItemMedia>
              <ItemContent>
                <RecordTitle item={item} />
                <ItemDescription>
                  <span className="font-semibold text-foreground">Why it stays:</span>{' '}
                  {item.ineligibleReason
                    ? CONCRETE_MIX_PROPAGATION_INELIGIBLE_LABEL[item.ineligibleReason]
                    : 'It can’t take the new values.'}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </Group>
      ) : null}

      {canDecide ? (
        <div className="sticky bottom-0 flex flex-wrap items-end justify-between gap-4 border-t bg-background py-4">
          <Field className="max-w-md min-w-60 flex-1">
            <FieldLabel htmlFor={`${id}-note`}>Note for the mix history</FieldLabel>
            <Input
              id={`${id}-note`}
              maxLength={2000}
              value={note}
              placeholder="Optional. Why these records are updated"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm" role="status">
              <span className="font-mono font-semibold">{chosen.length}</span> of {eligible.length}{' '}
              chosen
            </p>
            <Button variant="outline" disabled={blocked} onClick={() => setConfirmAll(true)}>
              Approve all {eligible.length}
            </Button>
            <Button disabled={blocked || chosen.length === 0} onClick={() => decide('items')}>
              <Check aria-hidden="true" />
              Apply to {chosen.length} {chosen.length === 1 ? 'record' : 'records'}
            </Button>
          </div>
        </div>
      ) : null}

      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve all listed records?</AlertDialogTitle>
            <AlertDialogDescription>
              All {eligible.length} records that can take revision {preview.toRevisionNumber}’s
              values are updated, including those under Your call (their hand-changed values are
              kept). Records under Won’t change stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={() => decide('approve_all')}>Update {eligible.length}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Group({
  id,
  title,
  count,
  hint,
  children,
}: {
  id: string;
  title: string;
  count: number;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        <span className="font-mono text-sm text-muted-foreground tabular-nums">{count}</span>
        <span className="text-sm text-muted-foreground">{hint}</span>
      </div>
      <ItemGroup className="gap-2">{children}</ItemGroup>
    </section>
  );
}
