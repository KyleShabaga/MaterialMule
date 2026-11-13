import { receiptDraftDeleteHint, type MeResponse } from '@materialmule/shared';
import { ArrowRight, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { notifyError, notifySuccess } from '@/components/strata/toast';
import { StageTag } from '@/components/strata/stage-tag';
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
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSavedDateTime } from './format';
import { deleteAvailability, DraftDeleteError, type DraftOwnershipState } from './ownership';
import type { StoredDraft } from './record';

// "Drafts on this computer" as Strata Items (STRATA-78, canvas R2LogContent): Continue and Delete
// draft. Drafts are never inventory or confirmed receipts: no storage unit IDs, a Draft tag, and
// the line that they live in this browser only. Delete follows STRATA-108: only the person who
// started it or a Lab Manager; everyone else sees it disabled with the reason. Deleting asks
// first, and the draft goes only once the server has authorized it.

export function DraftItems({
  drafts,
  me,
  ownership,
  continueHref,
  onDelete,
}: {
  /** The drafts this session may see, or null while they load. */
  drafts: StoredDraft[] | null;
  me: Pick<MeResponse, 'id'>;
  ownership: DraftOwnershipState;
  continueHref: (record: StoredDraft) => string;
  /** Authorizes on the server, then removes the local copy. Throws DraftDeleteError. */
  onDelete: (record: StoredDraft) => Promise<void>;
}) {
  const [asking, setAsking] = useState<StoredDraft | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirmDelete() {
    const record = asking;
    if (!record) return;
    setBusy(true);
    try {
      await onDelete(record);
      notifySuccess('Draft deleted from this computer');
      setAsking(null);
    } catch (error) {
      notifyError(
        error instanceof DraftDeleteError ? error.message : "The draft couldn't be deleted.",
      );
      setAsking(null);
    } finally {
      setBusy(false);
    }
  }

  if (drafts !== null && drafts.length === 0) return null;
  const count = drafts?.length ?? null;

  return (
    <section aria-labelledby="receiving-log-drafts" className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 id="receiving-log-drafts" className="text-base font-semibold">
            Drafts on this computer
          </h2>
          {count !== null ? (
            <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Saved in this browser only. No IDs are issued until a draft is confirmed. A draft can be
          deleted by the person who started it or a Lab Manager.
        </p>
      </div>
      {drafts === null ? (
        <div aria-busy="true" className="space-y-2">
          <span role="status" className="sr-only">
            Loading drafts on this computer
          </span>
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-2">
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-3 w-44" />
              </div>
              <Skeleton className="h-9 w-28" />
            </div>
          ))}
        </div>
      ) : (
        <TooltipProvider delayDuration={300}>
          <ItemGroup role="list" aria-label="Drafts on this computer" className="gap-2">
            {drafts.map((record) => {
              const project = record.data.project;
              const units = record.data.units.length;
              const name = project ? project.projectNumber : 'a delivery with no project yet';
              const { allowed, ownership: owned } = deleteAvailability(ownership, record.draftId);
              const starter = owned?.starter ?? (record.legacy ? null : record.starter);
              const startedBy = !starter
                ? 'Started by someone not recorded'
                : starter.userId === me.id
                  ? 'Started by you'
                  : `Started by ${starter.name}`;
              const hint = owned
                ? receiptDraftDeleteHint(owned)
                : record.legacy
                  ? 'Only a Lab Manager can delete it'
                  : null;
              const deleteLabel = allowed || !hint ? 'Delete draft' : `Delete draft. ${hint}`;
              return (
                <Item
                  key={record.draftId}
                  role="listitem"
                  variant="outline"
                  size="sm"
                  className="bg-card"
                  data-draft-id={record.draftId}
                >
                  <ItemContent className="min-w-0">
                    <ItemTitle className="w-full min-w-0 flex-wrap">
                      <StageTag stage="draft" label="Draft · Receipt" />
                      {project ? (
                        <span className="min-w-0">
                          <span className="font-mono">{project.projectNumber}</span> {project.name}
                        </span>
                      ) : (
                        <span>No project yet</span>
                      )}
                      <span className="text-muted-foreground">
                        · {units} {units === 1 ? 'unit' : 'units'}
                      </span>
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {startedBy} · last saved {formatSavedDateTime(record.lastSavedAt)}
                      {record.status === 'confirming'
                        ? ' · Confirmation interrupted: continue to finish it'
                        : ''}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button variant="outline" asChild>
                      <Link to={continueHref(record)} aria-label={`Continue draft for ${name}`}>
                        <ArrowRight aria-hidden="true" />
                        Continue
                      </Link>
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {/* A disabled button gets no pointer events: the span keeps the tooltip. */}
                        <span data-slot="delete-draft-hint" tabIndex={allowed ? -1 : 0}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={deleteLabel}
                            disabled={!allowed}
                            onClick={() => setAsking(record)}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{allowed || !hint ? 'Delete draft' : hint}</TooltipContent>
                    </Tooltip>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        </TooltipProvider>
      )}
      <AlertDialog
        open={asking !== null}
        onOpenChange={(open) => !open && !busy && setAsking(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              {asking?.data.project ? `${asking.data.project.projectNumber}: ` : ''}
              everything entered is removed from this computer. This can’t be undone.
              {asking?.status === 'confirming'
                ? ' If its confirmation already went through, the storage units stay in Material Mule.'
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep draft</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
