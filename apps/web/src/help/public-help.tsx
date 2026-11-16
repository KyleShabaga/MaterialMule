import { ArrowLeft, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { DonkeyMark } from '../layout/DonkeyMark';
import { useSession } from '../session/context';
import {
  WHO_IS_WORKING_PATH,
  readStoredPerson,
  stationSessionKey,
} from '../session/recording-person-store';
import { HelpGuidesView } from './HelpGuidesView';

// /help without the app (STRATA-103, finishing STRATA-105's gate; Kyle 2026-11-12): the same
// guides as signed in, without the sidebar, with a way back. It reads nothing private: the
// guides are static and the version comes from the public /api/health.

type Back = { to: string; label: string; notice: boolean };

/**
 * Who sees the public /help: anyone signed out, someone waiting for approval, and a LAB station
 * before a person is picked ("How LAB stations work" on the picker). Null: the shell's /help.
 */
function publicHelpBack(session: ReturnType<typeof useSession>['session']): Back | null {
  if (session.status === 'signed-out') {
    return { to: '/sign-in', label: 'Back to sign in', notice: true };
  }
  if (session.status === 'pending') {
    return { to: '/access-pending', label: 'Back', notice: false };
  }
  if (
    session.status === 'active' &&
    session.me.accountType === 'shared_lab' &&
    !readStoredPerson(stationSessionKey(session.me))
  ) {
    return { to: WHO_IS_WORKING_PATH, label: 'Back to Who is working here?', notice: false };
  }
  return null;
}

/**
 * Wraps the signed-in guard (routes.tsx): on /help, a visitor without the app gets the public
 * Help page instead of the sign-in redirect; everything else goes through `children` as before.
 */
export function PublicHelpGate({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const { pathname } = useLocation();
  const isHelp = pathname === '/help' || pathname === '/help/';
  const back = isHelp ? publicHelpBack(session) : null;
  if (back) return <PublicHelpPage back={back} />;
  return children;
}

function PublicHelpPage({ back }: { back: Back }) {
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background px-6 max-sm:px-4">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        >
          <DonkeyMark />
        </span>
        <span className="font-semibold">Material Mule</span>
        <span className="text-sm text-muted-foreground max-sm:hidden">Help</span>
        <Button asChild variant="link" className="ml-auto px-0 pointer-coarse:h-11">
          <Link to={back.to}>
            <ArrowLeft aria-hidden="true" />
            {back.label}
          </Link>
        </Button>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-[1280px] px-8 py-6 outline-none max-sm:px-4"
      >
        <HelpGuidesView
          notice={
            back.notice ? (
              <p className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-[13px] text-accent-foreground">
                <Info className="size-4 shrink-0" aria-hidden="true" />
                You’re not signed in. These guides need no account; sign in to use the app.
              </p>
            ) : undefined
          }
        />
      </main>
    </div>
  );
}
