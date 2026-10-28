import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { PageHeader } from '../components/ui';
import { useMe } from '../session/context';
import './lab.css';

/**
 * One "Lab Testing" area (MM-T23/T24 wireframe decision): Programs tab and New program in the
 * header. The Worklist tab (MM-T24) becomes the default once it exists, so no dead tab is shown
 * before then.
 */
export function LabTestingLayout({ worklist = false }: { worklist?: boolean }) {
  const me = useMe();
  const location = useLocation();
  const canEnter = me.permissions.includes('lab_program.manage');
  const onEditor = location.pathname.endsWith('/programs/new');
  return (
    <>
      <PageHeader
        title="Lab Testing"
        actions={
          canEnter && !onEditor ? (
            <Link className="button primary" to="/lab-testing/programs/new">
              New program
            </Link>
          ) : null
        }
      />
      <nav className="sub-nav" aria-label="Lab Testing">
        {worklist ? (
          <NavLink to="/lab-testing" end>
            Worklist
          </NavLink>
        ) : null}
        <NavLink to="/lab-testing/programs">Programs</NavLink>
      </nav>
      <Outlet />
    </>
  );
}
