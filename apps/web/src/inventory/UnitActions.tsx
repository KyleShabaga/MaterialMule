import type { StorageUnitDetail } from '@materialmule/shared';
import { ArrowRightLeft, Ellipsis, Hourglass, Link2, Pencil, Printer } from 'lucide-react';
import { useId, useRef, type Ref } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StageTag } from '../components/strata/stage-tag';
import { notifyError, notifySuccess } from '../components/strata/toast';
import type { MoveLinkState } from '../moves/move-link';
import { unitPrintPath } from '../printing/print-paths';
import {
  retentionDecidePath,
  unitPath,
  type UnitPrimaryAction,
  type UnitTagWords,
} from './unit-record';

/**
 * The record tag and, for an open location conflict, a second tag. The wrapper keeps the
 * `unit-status-tags` hook that E2E specs read.
 */
export function UnitStatusTags({ tag, conflict }: { tag: UnitTagWords; conflict: boolean }) {
  return (
    <div className="unit-status-tags flex flex-wrap items-center gap-2">
      <StageTag stage={tag.stage} label={tag.label} />
      {conflict ? <StageTag stage="danger" label="Urgent · Location" /> : null}
    </div>
  );
}

/** The one main action. Move links carry the unit so Move units opens with it chosen. */
export function UnitPrimaryButton({
  unit,
  action,
  variant = 'default',
}: {
  unit: Pick<StorageUnitDetail, 'readableId' | 'project'>;
  action: UnitPrimaryAction;
  variant?: 'default' | 'outline';
}) {
  if (action.kind === 'none') return null;
  if (action.kind === 'decide') {
    return (
      <Button asChild variant={variant}>
        <Link to={retentionDecidePath(unit.project.id)}>
          <Hourglass aria-hidden="true" />
          {action.label}
        </Link>
      </Button>
    );
  }
  return (
    <Button asChild variant={variant}>
      <Link to="/sample-storage/move" state={{ units: [unit.readableId] } satisfies MoveLinkState}>
        <ArrowRightLeft aria-hidden="true" />
        {action.label}
      </Link>
    </Button>
  );
}

async function copyUnitLink(readableId: string) {
  const url = `${window.location.origin}${unitPath(readableId)}`;
  try {
    await navigator.clipboard.writeText(url);
    notifySuccess('Link copied.');
  } catch {
    notifyError('The link couldn’t be copied.', url);
  }
}

/**
 * More: Print label, Correct and Copy link. A disabled item says why on its own line under it
 * (aria-describedby). Hiding or disabling is a courtesy: corrections are enforced on the server.
 */
export function UnitMoreMenu({
  unit,
  canCorrect,
  onCorrect,
  triggerRef,
}: {
  unit: Pick<StorageUnitDetail, 'readableId' | 'status'>;
  canCorrect: boolean;
  onCorrect: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const id = useId();
  const disposed = unit.status === 'disposed';
  const printReason = `${id}-print`;
  const correctReason = `${id}-correct`;
  // Correct replaces the page and focuses its heading; the menu must not pull focus back.
  const correcting = useRef(false);
  const reason = 'text-muted-foreground -mt-1 pr-2 pb-1.5 pl-8 text-xs';
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} variant="outline" size="icon" aria-label="More actions">
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        onCloseAutoFocus={(event) => {
          if (correcting.current) {
            correcting.current = false;
            event.preventDefault();
          }
        }}
      >
        {disposed ? (
          <>
            <DropdownMenuItem disabled aria-describedby={printReason}>
              <Printer aria-hidden="true" />
              Print label
            </DropdownMenuItem>
            <p id={printReason} className={reason}>
              Disposed units’ labels can’t be reprinted.
            </p>
          </>
        ) : (
          <DropdownMenuItem asChild>
            <Link to={unitPrintPath(unit.readableId)}>
              <Printer aria-hidden="true" />
              Print label
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={!canCorrect}
          aria-describedby={!canCorrect || disposed ? correctReason : undefined}
          onSelect={() => {
            correcting.current = true;
            onCorrect();
          }}
        >
          <Pencil aria-hidden="true" />
          Correct
        </DropdownMenuItem>
        {!canCorrect ? (
          <p id={correctReason} className={reason}>
            Corrections need a personal account.
          </p>
        ) : disposed ? (
          // BUG-014 (owner decision): a disposed unit keeps only these two corrections.
          <p id={correctReason} className={reason}>
            Only the received date and note can change.
          </p>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void copyUnitLink(unit.readableId)}>
          <Link2 aria-hidden="true" />
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
