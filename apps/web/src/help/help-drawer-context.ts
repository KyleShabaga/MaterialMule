import { createContext, useContext } from 'react';

export type HelpView = { kind: 'home' } | { kind: 'shortcuts' } | { kind: 'group'; id: string };

export interface OpenHelpOptions {
  /** Start on Keyboard shortcuts or one group instead of help for this page. */
  view?: HelpView;
  /** Where focus goes back on close; default: whatever had focus when Help opened. */
  returnFocus?: HTMLElement | null;
  /**
   * Another layer (a menu, the command menu) is closing and will hand focus over itself by
   * calling `focusDrawer()`; the drawer then doesn't take focus on its own.
   */
  deferFocus?: boolean;
}

/**
 * The Help drawer (STRATA-103): `?` or account menu › Help opens it beside the current page.
 * Under 1024 px there is no drawer: `open` goes to the /help page instead.
 */
export interface HelpDrawerController {
  isOpen: boolean;
  open(options?: OpenHelpOptions): void;
  close(): void;
  /** `?`: opens, or closes when open. */
  toggle(options?: OpenHelpOptions): void;
  /** Moves focus into the open drawer (its heading). */
  focusDrawer(): void;
}

export const HelpDrawerContext = createContext<HelpDrawerController | null>(null);

/** The shell's Help drawer, or null outside the shell (signed-out /help, tests). */
export function useOptionalHelpDrawer(): HelpDrawerController | null {
  return useContext(HelpDrawerContext);
}
