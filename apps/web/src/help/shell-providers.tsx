import type { ReactNode } from 'react';
import { FeedbackDialogProvider } from '../feedback/FeedbackDialog';
import { CommandMenuProvider } from '../search/command-menu';
import { HelpDrawerProvider } from './help-drawer';

/**
 * The shell's overlays, outermost first: Feedback & bugs (STRATA-104), the Help drawer
 * (STRATA-103) and the Ctrl K command menu, which opens Help from `?` and its Help group.
 */
export function ShellOverlayProviders({ children }: { children: ReactNode }) {
  return (
    <FeedbackDialogProvider>
      <HelpDrawerProvider>
        <CommandMenuProvider>{children}</CommandMenuProvider>
      </HelpDrawerProvider>
    </FeedbackDialogProvider>
  );
}
