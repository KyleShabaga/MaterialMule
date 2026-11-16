import {
  JOB_TITLE_SOURCE_LABEL,
  ROLE_LABELS,
  STAFF_CAPABILITY_LABEL,
  formatPerson,
  type AccessProject,
  type AccessSummary,
  type MeResponse,
} from '@materialmule/shared';
import { Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { shortDateTime } from '../../dashboard/format';
import { useMe } from '../../session/context';
import { GLOBAL_ABILITIES } from '../access/abilities';
import { fetchMyAccess } from '../access/api';
import { SettingsGroup, SettingsPanel } from '../modal/SettingsPanel';
import { StaffApiError } from '../staff/api';
import { FactList, FactRow } from './ProfilePanel';

// Settings › Account › My access (MM-AO06, STRATA-101; canvas R9AccountPanel access and
// access-blocked). What the person can do and where each part comes from, as the server reports
// it: global abilities from the session's permissions, roles, grants held everywhere, and per
// project responsibilities and scoped grants. Read-only; the server checks every action.

type State =
  | { state: 'loading' }
  | { state: 'error'; message: string; forbidden: boolean }
  | { state: 'ready'; data: AccessSummary };

function started(row: { since: string; by: { initials: string | null; name: string } }) {
  return `since ${shortDateTime(row.since)}, by ${formatPerson(row.by.initials, row.by.name)}`;
}

const REVIEWER_BLOCKED = {
  account_not_active: 'not effective: account isn’t active',
  eligibility_revoked: 'not effective: eligibility revoked',
} as const;

const ISSUER_BLOCKED = {
  account_not_active: 'not effective: account isn’t active',
  expired: 'not effective: expired',
} as const;

function projectParts(entry: AccessProject) {
  const responsibilities: string[] = [];
  if (entry.lead) responsibilities.push('Lead Project Engineer');
  if (entry.teamMember) responsibilities.push(`Team member (${started(entry.teamMember)})`);
  for (const r of entry.reviewer) {
    responsibilities.push(
      `Reviewer: ${r.scope.label} (${started(r)}${r.blockedReason ? `; ${REVIEWER_BLOCKED[r.blockedReason]}` : ''})`,
    );
  }
  if (entry.pendingLeadNomination) {
    responsibilities.push('Nominated as Lead Project Engineer, waiting for an admin');
  }
  const grants: string[] = [];
  if (entry.acceptanceDelegate) {
    grants.push(`Acceptance delegate (${started(entry.acceptanceDelegate)})`);
  }
  for (const g of entry.reportIssuer) {
    grants.push(
      `Report issuer: ${g.scope.label} (${started(g)}${
        g.expiresAt ? `; expires ${shortDateTime(g.expiresAt)}` : ''
      }${g.blockedReason ? `; ${ISSUER_BLOCKED[g.blockedReason]}` : ''})`,
    );
  }
  return { responsibilities, grants };
}

/** "From: Lab Technician role" — global permissions come with the account's app roles. */
function roleSource(roles: MeResponse['roles']): string {
  if (roles.length === 0) return 'From: Everyone';
  const labels = roles.map((role) => ROLE_LABELS[role]);
  return `From: ${labels.join(' and ')} ${labels.length > 1 ? 'roles' : 'role'}`;
}

function BlockedNotice({ label }: { label: string }) {
  return (
    <Alert>
      <Info />
      <AlertTitle>{label} isn’t available to you.</AlertTitle>
      <AlertDescription>
        <p>
          Settings opened on My access instead. It shows what you can do and where each part comes
          from.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function Foot({ children }: { children: ReactNode }) {
  return (
    <p data-slot="access-foot" className="m-0 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function AccessPanel({ blockedSection }: { blockedSection?: string } = {}) {
  const me = useMe();
  const notice = blockedSection ? <BlockedNotice label={blockedSection} /> : null;
  return me.accountType === 'shared_lab' ? (
    <StationAccess me={me} notice={notice} />
  ) : (
    <PersonalAccess me={me} notice={notice} />
  );
}

/** Held global abilities, in the order of GLOBAL_ABILITIES. */
function heldAbilities(me: MeResponse) {
  return GLOBAL_ABILITIES.filter((ability) => me.permissions.includes(ability.permission));
}

function StationAccess({ me, notice }: { me: MeResponse; notice: ReactNode }) {
  const id = useId();
  const held = heldAbilities(me);
  return (
    <SettingsPanel
      id="access"
      title="My access"
      description="What this shared LAB account can do. The server checks every action; this page only explains it."
      notice={notice}
    >
      <SettingsGroup id={`${id}-account`} title="Account">
        <FactList>
          <FactRow
            label="Account"
            hint="A shared account for the receiving bench. It can’t hold roles."
          >
            Shared LAB account
          </FactRow>
          <FactRow
            label="Recording as"
            hint="Picking a person credits the work to them. It never gives this account their roles or access."
          >
            Whoever is picked on this station
          </FactRow>
        </FactList>
      </SettingsGroup>
      <SettingsGroup id={`${id}-what`} title="What this account can do">
        {held.length ? (
          <FactList label="What this account can do">
            {held.map((ability) => (
              <FactRow
                key={ability.permission}
                label={ability.what}
                hint="From: Shared LAB account"
              >
                {ability.note}
              </FactRow>
            ))}
          </FactList>
        ) : (
          <p data-slot="access-empty" className="m-0 py-4 text-sm text-muted-foreground">
            Nothing beyond what everyone can see.
          </p>
        )}
      </SettingsGroup>
      <Foot>
        Personal access (roles, grants, projects) belongs to personal accounts. Sign in with your
        own account to see yours.
      </Foot>
    </SettingsPanel>
  );
}

function PersonalAccess({ me, notice }: { me: MeResponse; notice: ReactNode }) {
  const id = useId();
  const [page, setPage] = useState<State>({ state: 'loading' });
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let current = true;
    fetchMyAccess().then(
      (data) => current && setPage({ state: 'ready', data }),
      (error: unknown) =>
        current &&
        setPage({
          state: 'error',
          forbidden: error instanceof StaffApiError && error.forbidden,
          message:
            error instanceof StaffApiError
              ? error.message
              : 'Material Mule couldn’t be reached. Check the connection.',
        }),
    );
    return () => {
      current = false;
    };
  }, [reloads]);

  // A grant or revocation made meanwhile shows when the window comes back.
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);

  const summary = page.state === 'ready' ? page.data : null;
  const roles = summary?.roles ?? me.roles;
  const held = heldAbilities(me);

  return (
    <SettingsPanel
      id="access"
      title="My access"
      description="What you can do, as the server reports it. The server checks every action; this page only explains it."
      notice={notice}
      actions={
        <Button variant="outline" size="sm" onClick={reload}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      }
    >
      <SettingsGroup id={`${id}-roles`} title="App roles">
        <div data-slot="access-roles" className="flex flex-wrap items-center gap-2 py-4">
          {roles.length ? (
            <>
              <ul
                data-slot="access-role-list"
                aria-label="App roles"
                className="m-0 flex list-none flex-wrap gap-2 p-0"
              >
                {roles.map((role) => (
                  <li key={role} data-slot="access-role">
                    <Badge variant="secondary">{ROLE_LABELS[role]}</Badge>
                  </li>
                ))}
              </ul>
              <span className="text-sm text-muted-foreground">
                Granted by an administrator, with a reason.
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              No app roles. Staff without a role can still see everything.
            </span>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup id={`${id}-what`} title="What you can do">
        <FactList label="What you can do">
          {held.map((ability) => (
            <FactRow key={ability.permission} label={ability.what} hint={roleSource(me.roles)}>
              {ability.note}
            </FactRow>
          ))}
          <FactRow label="Projects" hint="From: Everyone">
            See every project
          </FactRow>
          <FactRow label="Settings" hint="From: Everyone">
            Your own profile, preferences and notifications
          </FactRow>
        </FactList>
      </SettingsGroup>

      {page.state === 'loading' ? (
        <div className="grid gap-3" aria-hidden="true">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : null}
      {page.state === 'error' ? (
        page.forbidden ? (
          <Foot>
            My access is for personal accounts. Sign in with your own account to see your grants and
            projects.
          </Foot>
        ) : (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Your grants and projects couldn’t load.</AlertTitle>
            <AlertDescription>
              <p>{page.message}</p>
              <Button variant="outline" size="sm" onClick={reload}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )
      ) : null}

      {summary ? (
        <>
          <SettingsGroup id={`${id}-everywhere`} title="Held everywhere">
            {summary.capabilities.length || summary.reviewerEligibility.length ? (
              <FactList label="Held everywhere">
                {summary.capabilities.map((grant) => (
                  <FactRow
                    key={grant.id}
                    label={STAFF_CAPABILITY_LABEL[grant.capability]}
                    hint={`From: an administrator, since ${shortDateTime(grant.startedAt)}, by ${formatPerson(grant.startedBy.initials, grant.startedBy.name)}`}
                  >
                    Every project
                  </FactRow>
                ))}
                {summary.reviewerEligibility.map((grant) => (
                  <FactRow
                    key={grant.id}
                    label="Eligible reviewer"
                    hint={`From: an administrator, since ${shortDateTime(grant.startedAt)}, by ${formatPerson(grant.startedBy.initials, grant.startedBy.name)}`}
                  >
                    {grant.scope.label}
                  </FactRow>
                ))}
              </FactList>
            ) : (
              <p data-slot="access-empty" className="m-0 py-4 text-sm text-muted-foreground">
                No reviewer eligibility or capabilities.
              </p>
            )}
          </SettingsGroup>

          <SettingsGroup id={`${id}-projects`} title="Projects">
            {summary.projects.length ? (
              <FactList label="Project access">
                {summary.projects.map((entry) => {
                  const { responsibilities, grants } = projectParts(entry);
                  return (
                    <FactRow
                      key={entry.project.id}
                      label={
                        <Link
                          to={`/projects/${encodeURIComponent(entry.project.id)}`}
                          data-slot="access-project-link"
                          className="font-mono text-link underline-offset-4 hover:underline"
                        >
                          {entry.project.projectNumber}
                        </Link>
                      }
                      hint={`From: Project team, ${entry.project.projectNumber}`}
                    >
                      <span className="grid gap-0.5">
                        <span>{entry.project.name}</span>
                        {responsibilities.length ? (
                          <span>Responsibilities: {responsibilities.join('; ')}</span>
                        ) : null}
                        {grants.length ? <span>Grants: {grants.join('; ')}</span> : null}
                      </span>
                    </FactRow>
                  );
                })}
              </FactList>
            ) : (
              <p data-slot="access-empty" className="m-0 py-4 text-sm text-muted-foreground">
                No project assignments. Everyone can see all projects.
              </p>
            )}
            {summary.projectsTotal > summary.projects.length ? (
              <Foot>
                Showing the first {summary.projects.length} of {summary.projectsTotal} projects.
              </Foot>
            ) : null}
          </SettingsGroup>
        </>
      ) : null}

      <Foot>
        {summary?.effectiveJobTitle
          ? `Your job title, ${summary.effectiveJobTitle.value} (${JOB_TITLE_SOURCE_LABEL[summary.effectiveJobTitle.source]}), describes the work; it grants nothing.`
          : 'A job title describes the work; it grants nothing.'}{' '}
        Concrete authority is always per project. Ask your Lab Manager if something you need is
        missing.
      </Foot>
    </SettingsPanel>
  );
}
