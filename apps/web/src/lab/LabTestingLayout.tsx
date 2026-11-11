import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { ContextRow } from '../layout/ContextRow';
import { useMe } from '../session/context';
import './lab.css';
import './lab-ledger.css';

/**
 * One "Lab programs" area (MM-T23/T24 wireframe decision, Field Ledger "Lab"): Worklist (default)
 * and Programs tabs, New lab program in the context row. `worklist` is off only while MM-T24
 * isn't there, so no dead tab is ever shown. A program page and the editor are records of their
 * own: they open under a back link with their own page title instead of the tabs.
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
      <div className="lab-area">
        <ContextRow>
          <Link className="lab-back" to="/lab-testing/programs">
            All lab programs
          </Link>
        </ContextRow>
        <Outlet />
      </div>
    );
  }
  return (
    <div className="lab-area">
      {canEnter ? (
        <ContextRow align="end">
          <Link className="button primary" to="/lab-testing/programs/new">
            New lab program
          </Link>
        </ContextRow>
      ) : null}
      <div className="lab-title">
        <h1>Lab programs</h1>
        <span className="lab-title-meta">Progress only, no results</span>
      </div>
      <nav className="sub-nav" aria-label="Lab programs">
        {worklist ? (
          <NavLink to="/lab-testing" end>
            Worklist
          </NavLink>
        ) : null}
        <NavLink to="/lab-testing/programs">Programs</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
