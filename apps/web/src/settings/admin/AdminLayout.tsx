import { FlaskConical, MapPin, Settings, Users, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, NavLink } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usePageTitle } from '../../layout/page-title';
import { useMe } from '../../session/context';
import { LocationsPage } from '../locations/LocationsPage';
import { TestsSettingsPage } from '../lab/LabCatalogueSettings';
import { StaffPage } from '../staff/StaffPage';
import { findSection, visibleSections } from '../modal/registry';

type AdminTab = 'staff' | 'locations' | 'lab-tests';

interface TabDef {
  key: AdminTab;
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

const TABS: TabDef[] = [
  {
    key: 'staff',
    to: '/admin/staff',
    label: 'Staff',
    icon: Users,
    description: 'Who can sign in, their roles, and applicants waiting for approval.',
  },
  {
    key: 'locations',
    to: '/admin/locations',
    label: 'Locations',
    icon: MapPin,
    description: 'Warehouses, bays and shelves, their storage terms and their labels.',
  },
  {
    key: 'lab-tests',
    to: '/admin/lab-tests',
    label: 'Lab tests',
    icon: FlaskConical,
    description: 'The soils test catalogue the program editor offers.',
  },
];

/**
 * Lab admin (STRATA-128; DESIGN.md › Round 9): Staff, Locations and Lab tests as full pages,
 * because up to 150 people and 2,000 locations don't fit the Settings modal. Line tabs across
 * the top (links), the page's h1 and one line, then the section; a ghost button opens the
 * Settings modal for the rest of the Lab settings.
 *
 * Staff needs `staff.manage` and Lab tests `test_catalog.manage` (a direct address without it
 * opens Settings › My access with a notice). Locations stays readable by everyone, as today
 * (MISC-04: everyone keeps the print-only Locations view), though only Lab Managers and
 * administrators see it in the Settings nav; its controls show only to those who may change
 * them, and the server checks every change.
 */
export function AdminPage({ tab }: { tab: AdminTab }) {
  const me = useMe();
  const canStaff = me.permissions.includes('staff.manage');
  const canTests = me.permissions.includes('test_catalog.manage');
  const current = TABS.find((item) => item.key === tab)!;
  usePageTitle(`${current.label} · Lab admin`);

  if ((tab === 'staff' && !canStaff) || (tab === 'lab-tests' && !canTests)) {
    return <Navigate to="/settings/access" replace state={{ settingsBlocked: current.label }} />;
  }

  const tabs = TABS.filter(
    (item) => (item.key !== 'staff' || canStaff) && (item.key !== 'lab-tests' || canTests),
  );
  const modalSection = visibleSections(me).find((section) =>
    ['printers', 'templates', 'receiving'].includes(section.slug),
  );

  let body: ReactNode;
  if (tab === 'staff') body = <StaffPage />;
  else if (tab === 'locations') body = <LocationsPage />;
  else body = <TestsSettingsPage />;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-admin-page={tab}>
      <nav
        aria-label="Lab administration"
        className="flex h-12 shrink-0 items-end gap-3 border-b px-4 md:px-8"
      >
        <ul className="flex gap-4">
          {tabs.map((item) => (
            <li key={item.key}>
              <AdminTabLink tab={item} />
            </li>
          ))}
        </ul>
        {modalSection ? (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="ml-auto self-center text-muted-foreground max-sm:hidden"
          >
            <Link
              to={`/settings/${modalSection.slug}`}
              title={`Opens Settings on ${findSection(modalSection.slug)?.label}`}
            >
              <Settings aria-hidden="true" />
              Printers, templates and receiving
            </Link>
          </Button>
        ) : null}
      </nav>
      <div className="px-4 pt-8 pb-4 md:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">{current.label}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{current.description}</p>
      </div>
      <div className="settings-content min-h-0 flex-1 px-4 pb-10 md:px-8">{body}</div>
    </div>
  );
}

function AdminTabLink({ tab }: { tab: TabDef }) {
  const Icon = tab.icon;
  return (
    <NavLink
      to={tab.to}
      data-slot="admin-tab"
      className={({ isActive }) =>
        cn(
          'relative inline-flex h-11 items-center gap-1.5 px-1 text-sm font-medium whitespace-nowrap outline-none',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-4',
          'after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:bg-foreground',
          isActive
            ? 'text-foreground after:opacity-100'
            : 'text-foreground/75 after:opacity-0 hover:text-foreground',
        )
      }
    >
      <Icon aria-hidden="true" />
      {tab.label}
    </NavLink>
  );
}
