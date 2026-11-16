import {
  LAB_PROGRAM_PHASE_TAG,
  type LabProgramPhase,
  type LabProgramSummary,
} from '@materialmule/shared';
import { Flag } from 'lucide-react';
import { StageTag } from '../components/strata/stage-tag';

// Program tags (STRATA-87): the status tag "<Stage> · <domain>" from the program's phase and the
// priority tag. The list, the drawer and the program page use these, so they always agree.

/** The status tag's phase: the server's, else from the status alone (older rows). */
// eslint-disable-next-line react-refresh/only-export-components -- the tag's phase rule belongs with it
export function programPhase(row: Pick<LabProgramSummary, 'status' | 'phase'>): LabProgramPhase {
  if (row.phase) return row.phase;
  return row.status === 'draft' ? 'draft' : row.status === 'closed' ? 'closed' : 'testing';
}

export function ProgramStatusTag({ phase }: { phase: LabProgramPhase }) {
  const tag = LAB_PROGRAM_PHASE_TAG[phase];
  return <StageTag stage={tag.stage} label={tag.label} />;
}

/** Urgent · Priority (outline, flag: not a status colour); Normal is plain text. */
export function PriorityTag({ priority }: { priority: LabProgramSummary['priority'] }) {
  return priority === 'urgent' ? (
    <StageTag variant="outline" icon={Flag} label="Urgent · Priority" />
  ) : (
    <span className="text-muted-foreground">Normal</span>
  );
}
