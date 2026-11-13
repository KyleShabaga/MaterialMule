import { Plus } from 'lucide-react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useMe } from '../session/context';
import './lab.css';
import './lab-ledger.css';

/**
 * The Lab programs area (STRATA-87, DESIGN.md › Shell and › Soils lab): the page title, line tabs
 * Workboard (default, /lab-testing) and Programs, and New lab program as the page's primary. The
 * tabs are links (each keeps its own URL), drawn as shadcn line tabs. A program page and the
 * editor are records of their own: they render without the area header (the top bar names them).
 * `worklist` is off only while the Workboard isn't there, so no dead tab is ever shown.
 */
export function LabTestingLayout({ worklist = false }: { worklist?: boolean }) {
  const me = useMe();
  const location = useLocation();
  const canEnter = me.permissions.includes('lab_program.manage');
  // The editor (/programs/new) and a program page (a draft opens in the editor).
  const onRecord = /^\/lab-testing\/programs\/[^/]+\/?$/.test(location.pathname);
  // Concrete breaks and holds keep their /lab-testing URLs but sit outside this layout: the
  // rail's Concrete group links them (routes.tsx).

  if (onRecord) {
    return (
      <div className="lab-area flex min-w-0 flex-col gap-4">
        <Outlet />
      </div>
    );
  }
  const tabs = [
    ...(worklist ? [{ to: '/lab-testing', label: 'Workboard', end: true }] : []),
    { to: '/lab-testing/programs', label: 'Programs', end: false },
  ];
  return (
    <div className="lab-area flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Lab programs</h1>
          <p className="text-sm text-muted-foreground">Progress only, no results</p>
        </div>
        {canEnter ? (
          <Button asChild>
            <Link to="/lab-testing/programs/new">
              <Plus aria-hidden="true" />
              New lab program
            </Link>
          </Button>
        ) : null}
      </header>
      <nav
        aria-label="Lab programs"
        data-slot="line-tabs"
        className="-mt-1 flex items-end gap-4 border-b"
      >
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            data-slot="line-tab"
            className={({ isActive }) =>
              cn(
                'relative -mb-px inline-flex h-9 items-center border-b-2 border-transparent px-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:h-11',
                isActive && 'border-foreground text-foreground',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
