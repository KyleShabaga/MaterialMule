import type { ProjectDetail } from '@materialmule/shared';
import { useOutletContext } from 'react-router';

/**
 * What the project page's layout (header + line tabs, STRATA-84) hands to each tab through the
 * router outlet. Tabs read the project from here instead of fetching it again.
 */
export interface ProjectLayoutContext {
  project: ProjectDetail;
  /** Reload the project (header counts, lead, nomination) after a tab changes something. */
  reloadProject: () => void;
  /**
   * One primary per screen (DESIGN.md › Projects): while a tab has a decision or form open
   * (nominate, admin decision, a needs-review reason, a grant change), it calls this with true,
   * and the header's "Receive for this project" turns outline. Call it with false when closed.
   */
  setFormOpen: (open: boolean) => void;
}

export function useProjectLayout(): ProjectLayoutContext {
  return useOutletContext<ProjectLayoutContext>();
}
