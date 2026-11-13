import { createContext, useContext, useEffect, useId } from 'react';

// One primary per screen (DESIGN.md › Projects): while any decision or form on the Team tab is
// open, the project header's "Receive for this project" turns outline. Each open form registers
// here; the tab tells the layout whether any is open.

export interface TeamFormRegistry {
  set: (key: string, open: boolean) => void;
}

export const TeamFormContext = createContext<TeamFormRegistry | null>(null);

/** Marks this component's form as open (or not) for as long as it is mounted. */
export function useTeamFormOpen(open: boolean): void {
  const registry = useContext(TeamFormContext);
  const key = useId();
  useEffect(() => {
    if (!registry || !open) return;
    registry.set(key, true);
    return () => registry.set(key, false);
  }, [registry, key, open]);
}
