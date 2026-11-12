import type { StageKey } from '@materialmule/shared';

// Colour classes for the Strata stages (DESIGN.md › Lifecycle). The stage keys, the six work-item
// words and the record status words live in packages/shared (stage.ts, lane 1C); this file only
// maps each key to literal Tailwind classes so Tailwind finds them.

/** Stripe and dot fill (`mark`, step 9) per stage. Literal class names so Tailwind finds them. */
export const STAGE_MARK_BG: Record<StageKey, string> = {
  draft: 'bg-stage-draft-mark',
  storage: 'bg-stage-storage-mark',
  lab: 'bg-stage-lab-mark',
  due: 'bg-stage-due-mark',
  danger: 'bg-stage-danger-mark',
  closed: 'bg-stage-closed-mark',
};

/** Tag fill and text (`bg` step 3, `fg` step 11/12) per stage. */
export const STAGE_TAG_CLASS: Record<StageKey, string> = {
  draft: 'bg-stage-draft-bg text-stage-draft-fg',
  storage: 'bg-stage-storage-bg text-stage-storage-fg',
  lab: 'bg-stage-lab-bg text-stage-lab-fg',
  due: 'bg-stage-due-bg text-stage-due-fg',
  danger: 'bg-stage-danger-bg text-stage-danger-fg',
  closed: 'bg-stage-closed-bg text-stage-closed-fg',
};

/** Solid current-step fill with its contrast text (lifecycle track). */
export const STAGE_SOLID_CLASS: Record<StageKey, string> = {
  draft: 'bg-stage-draft-mark text-stage-draft-contrast',
  storage: 'bg-stage-storage-mark text-stage-storage-contrast',
  lab: 'bg-stage-lab-mark text-stage-lab-contrast',
  due: 'bg-stage-due-mark text-stage-due-contrast',
  danger: 'bg-stage-danger-mark text-stage-danger-contrast',
  closed: 'bg-stage-closed-mark text-stage-closed-contrast',
};

/** Ring colour in the stage mark (compact lifecycle track's current square). */
export const STAGE_MARK_RING: Record<StageKey, string> = {
  draft: 'ring-stage-draft-mark',
  storage: 'ring-stage-storage-mark',
  lab: 'ring-stage-lab-mark',
  due: 'ring-stage-due-mark',
  danger: 'ring-stage-danger-mark',
  closed: 'ring-stage-closed-mark',
};

/** Border in the stage mark (banners and cards with a stage edge). */
export const STAGE_MARK_BORDER: Record<StageKey, string> = {
  draft: 'border-stage-draft-mark',
  storage: 'border-stage-storage-mark',
  lab: 'border-stage-lab-mark',
  due: 'border-stage-due-mark',
  danger: 'border-stage-danger-mark',
  closed: 'border-stage-closed-mark',
};
