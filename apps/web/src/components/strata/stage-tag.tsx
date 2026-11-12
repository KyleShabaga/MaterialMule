import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  STAGE_WORDS,
  STORAGE_UNIT_RECORD_STATUS_LABELS,
  STORAGE_UNIT_RECORD_STATUS_STAGE,
  workStageLabel,
  type StageKey,
  type StorageUnitRecordStatus,
  type WorkDomain,
} from '@materialmule/shared';
import { STAGE_MARK_BG } from './stage';

/** How a tag is written: a record's own status word (`label`) or a work item's domain. */
interface StageWording {
  /** Work item: renders "<Stage word> · <domain>" (shared `workStageLabel`), e.g. "Due · Retention". */
  domain?: WorkDomain;
  /** Record status: renders this word as is, e.g. "Short-term". Wins over `domain`. */
  label?: string;
}

interface CommonTagProps {
  /** A Lucide icon drawn before the word in place of the stage dot (e.g. Hourglass, Flag). */
  icon?: LucideIcon;
  className?: string;
}

export type StageTagProps =
  | ({ variant?: 'stage'; stage: StageKey } & StageWording & CommonTagProps)
  | ({
      /**
       * `neutral`: shadcn `secondary` look for waiting states (a HOLD inside its period, with an
       * Hourglass). `outline`: for things that aren't a status, e.g. "Urgent · Priority" with a
       * Flag (DESIGN.md › Lifecycle, "Red means act now").
       */
      variant: 'neutral' | 'outline';
      stage?: never;
      domain?: never;
      label: string;
    } & CommonTagProps);

/**
 * The words a stage tag shows: the record's own `label`, else "<Stage> · <domain>" for a work
 * item, else the bare stage word (DESIGN.md › Lifecycle, record tags vs work-item tags).
 */
// eslint-disable-next-line react-refresh/only-export-components -- shared wording helper, tested here
export function stageTagText(stage: StageKey, wording: StageWording = {}): string {
  if (wording.label) return wording.label;
  return wording.domain ? workStageLabel(stage, wording.domain) : STAGE_WORDS[stage];
}

type PlainTagProps = Extract<StageTagProps, { variant: 'neutral' | 'outline' }>;

function isPlainTag(props: StageTagProps): props is PlainTagProps {
  return props.variant === 'neutral' || props.variant === 'outline';
}

// Shared shape (DESIGN.md › Components › Tags): fully round, 24 px high, sans 600 13 px. In
// forced-colors mode the fill disappears, so the tag keeps a CanvasText border.
const TAG_SHAPE =
  'h-6 gap-1.5 rounded-full px-2.5 py-0 text-[13px] leading-none font-semibold forced-colors:border-[CanvasText] [&>svg]:size-3.5';

/**
 * A stage tag (STRATA-58), built on the shadcn `Badge` stage variants. Always a word, never a
 * dot alone; the 6 px dot (or `icon`) is decoration and hidden from screen readers.
 */
export function StageTag(props: StageTagProps) {
  const { icon: Icon, className } = props;

  if (isPlainTag(props)) {
    return (
      <Badge
        variant={props.variant === 'neutral' ? 'secondary' : 'outline'}
        data-tag-variant={props.variant}
        className={cn(TAG_SHAPE, className)}
      >
        {Icon ? <Icon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
        {props.label}
      </Badge>
    );
  }

  return (
    <Badge variant={props.stage} data-stage={props.stage} className={cn(TAG_SHAPE, className)}>
      {Icon ? (
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <span
          aria-hidden="true"
          data-slot="stage-dot"
          className={cn(
            'size-1.5 shrink-0 rounded-full forced-colors:bg-[CanvasText]',
            STAGE_MARK_BG[props.stage],
          )}
        />
      )}
      {stageTagText(props.stage, props)}
    </Badge>
  );
}

/**
 * The stage written for screen readers only, for dense cells where just a stripe shows
 * (DESIGN.md › Accessibility: status is always a word).
 */
export function StageSrText({ stage, domain, label }: { stage: StageKey } & StageWording) {
  return <span className="sr-only">{stageTagText(stage, { domain, label })}</span>;
}

/**
 * A storage unit's own tag from its record status (shared `StorageUnitRecordStatus`): the record
 * word ("Short-term", "Retention due") in its stage colour. `shelfCell` words come from the
 * caller (STORAGE_UNIT_SHELF_CELL_LABELS) through StageTag's `label` when space is tight.
 */
export function UnitStatusTag({
  status,
  className,
}: {
  status: StorageUnitRecordStatus;
  className?: string;
}) {
  return (
    <StageTag
      stage={STORAGE_UNIT_RECORD_STATUS_STAGE[status]}
      label={STORAGE_UNIT_RECORD_STATUS_LABELS[status]}
      className={className}
    />
  );
}
