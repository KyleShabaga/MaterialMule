import {
  POSITION_LABELS,
  ROLE_LABELS,
  type StaffMember,
  type StaffStatus,
} from '@materialmule/shared';
import { ChevronLeft, ChevronRight, UserPlus } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { DataTable, type DataTableColumn } from '../../components/strata/data-table';
import {
  PeekSplit,
  PeekToolbar,
  peekNeighbours,
  usePeekAvailable,
  usePeekKeys,
  usePeekParam,
} from '../../components/strata/peek';
import { PersonAvatar } from '../../components/strata/person-avatar';
import type { QueryFilterOption } from '../../components/strata/query-chips';
import { TableToolbar } from '../../components/strata/table-toolbar';
import {
  tableQueryKeys,
  useTableQuery,
  type SortLabels,
  type SortOption,
  type SortState,
} from '../../components/strata/table-query';
import { notifySuccess } from '../../components/strata/toast';
import { useMe } from '../../session/context';
import { AddStaffDialog } from './AddStaffDialog';
import { isStaffForbidden, listStaff, staffErrorMessage } from './api';
import { ACCOUNT_LABELS, disabledText, when } from './format';
import { LabAccountCard } from './LabAccountCard';
import { StaffDrawerBody } from './StaffDrawer';
import { PositionRulesSection } from './StaffGrantsSection';
import { ErrorAlert, StaffStatusBadge, TOUCH } from './staff-ui';

const REVOKED_MESSAGE = 'You no longer have permission to manage staff.';
/** Round 9: Staff is paged 20 per page. */
const STAFF_PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 250;

type StaffTab = 'people' | 'pending' | 'disabled';
const TAB_STATUS: Record<StaffTab, StaffStatus> = {
  people: 'active',
  pending: 'pending',
  disabled: 'disabled',
};
const TAB_LABELS: Record<StaffTab, string> = {
  people: 'People',
  pending: 'Pending',
  disabled: 'Disabled',
};
const isTab = (value: string | null): value is StaffTab =>
  value === 'people' || value === 'pending' || value === 'disabled';

const FILTERS: QueryFilterOption[] = [
  { id: 'lab_technician', label: 'Lab Technician' },
  { id: 'lab_manager', label: 'Lab Manager' },
  { id: 'admin', label: 'Admin' },
  { id: 'shared_lab', label: 'Shared LAB' },
];
const SORT_OPTIONS: SortOption[] = [
  { label: 'Name A–Z', sort: null },
  { label: 'Last sign-in, newest first', sort: { key: 'lastSignIn', dir: 'desc' } },
  { label: 'Position', sort: { key: 'position', dir: 'asc' } },
];
const SORT_LABELS: SortLabels = {
  name: { asc: 'Name A–Z', desc: 'Name Z–A' },
  position: { asc: 'Position', desc: 'Position, reversed' },
  lastSignIn: { asc: 'Last sign-in, oldest first', desc: 'Last sign-in, newest first' },
};

/** Every filter chip narrows the list (they combine with AND). */
function matchesFilter(member: StaffMember, filter: string): boolean {
  if (filter === 'shared_lab') return member.accountType === 'shared_lab';
  return member.roles.includes(filter as StaffMember['roles'][number]);
}

const byName = (a: StaffMember, b: StaffMember) =>
  a.displayName.localeCompare(b.displayName, 'en-CA', { sensitivity: 'base' });

function compare(sort: SortState | null): (a: StaffMember, b: StaffMember) => number {
  if (!sort) return byName;
  const sign = sort.dir === 'desc' ? -1 : 1;
  if (sort.key === 'lastSignIn') {
    // Never signed in sorts last either way.
    return (a, b) => {
      if (!a.lastSignInAt || !b.lastSignInAt) {
        return a.lastSignInAt ? -1 : b.lastSignInAt ? 1 : byName(a, b);
      }
      return sign * a.lastSignInAt.localeCompare(b.lastSignInAt) || byName(a, b);
    };
  }
  if (sort.key === 'position') {
    const label = (m: StaffMember) => (m.position ? POSITION_LABELS[m.position] : '￿');
    return (a, b) => sign * label(a).localeCompare(label(b)) || byName(a, b);
  }
  return (a, b) => sign * byName(a, b);
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

interface ListResult {
  key: string;
  at: number;
  data: { members: StaffMember[]; total: number } | null;
  error: { message: string; forbidden: boolean } | null;
}

/**
 * Loads the staff list whenever `key` changes, keeping the last rows on screen while the next
 * load runs (so a refresh after a change doesn't blank the table or close the drawer).
 */
function useStaffList(key: string, search: string) {
  const [result, setResult] = useState<ListResult>({ key: '', at: 0, data: null, error: null });
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });
  useEffect(() => {
    let current = true;
    listStaff({ search: searchRef.current, status: '' }).then(
      (data) => current && setResult({ key, at: Date.now(), data, error: null }),
      (error: unknown) =>
        current &&
        setResult((previous) => ({
          key,
          at: Date.now(),
          data: previous.data,
          error: { message: staffErrorMessage(error), forbidden: isStaffForbidden(error) },
        })),
    );
    return () => {
      current = false;
    };
  }, [key]);
  return {
    data: result.data,
    at: result.at,
    error: result.key === key ? result.error : null,
    loading: result.key !== key,
  };
}

/**
 * Lab admin › Staff (MM-T07, STRATA-102/128; DESIGN.md › Settings, round 9). Lab Managers and
 * administrators (STRATA-118); making or removing an admin, changing an admin's account, the LAB
 * password and position rules stay administrator-only. The server enforces all of it; this only
 * hides. AdminLayout renders the h1 and description above this.
 */
export function StaffPage() {
  const me = useMe();
  if (!me.permissions.includes('staff.manage')) {
    return (
      <p className="text-sm text-muted-foreground">
        Only Lab Managers and administrators can manage staff and access.
      </p>
    );
  }
  return <StaffAccess currentUserId={me.id} />;
}

/**
 * MM-T52: once any staff request is refused (403), the viewer has lost staff management. The
 * whole page, including Add staff, the LAB account and position rules, gives way to one message
 * with Retry; Retry loads everything again, so restored access needs no new sign-in.
 */
function StaffAccess({ currentUserId }: { currentUserId: string }) {
  const me = useMe();
  const [revoked, setRevoked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (revoked) {
    return (
      <ErrorAlert
        title={REVOKED_MESSAGE}
        onRetry={() => {
          setRevoked(false);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  const onForbidden = () => setRevoked(true);
  return (
    <div key={attempt} className="grid gap-10">
      <StaffDirectory currentUserId={currentUserId} onForbidden={onForbidden} />
      {/* The shared receiving account's password and stations (MM-T06), administrators only
          (STRATA-118: `lab_account.manage`). Below the table, as its own section. */}
      {me.permissions.includes('lab_account.manage') ? (
        <LabAccountCard onForbidden={onForbidden} />
      ) : null}
      {/* MISC-08: review eligibility by position (administrators only). */}
      {me.permissions.includes('reviewer_eligibility.manage') ? (
        <PositionRulesSection onForbidden={onForbidden} />
      ) : null}
    </div>
  );
}

function StaffDirectory({
  currentUserId,
  onForbidden,
}: {
  currentUserId: string;
  onForbidden: () => void;
}) {
  const me = useMe();
  const canAdmin = me.permissions.includes('admin_role.manage');
  const canPosition = me.permissions.includes('reviewer_eligibility.manage');
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const pageKey = tableQueryKeys().page;
  const tabParam = params.get('tab');
  const tab: StaffTab = isTab(tabParam) ? tabParam : 'people';
  const peek = usePeekParam();
  const peekAvailable = usePeekAvailable();
  const titleId = useId();

  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [fresh, setFresh] = useState<{ member: StaffMember; at: number } | null>(null);
  const search = useDebounced(query.search.trim(), SEARCH_DEBOUNCE_MS);
  const list = useStaffList(`${version}|${search}`, search);
  const refresh = () => setVersion((v) => v + 1);

  const forbidden = list.error?.forbidden ?? false;
  const onForbiddenRef = useRef(onForbidden);
  useEffect(() => {
    onForbiddenRef.current = onForbidden;
  });
  useEffect(() => {
    if (forbidden) onForbiddenRef.current();
  }, [forbidden]);

  const members = useMemo(() => list.data?.members ?? [], [list.data]);
  const counts = useMemo(() => {
    const c: Record<StaffStatus, number> = { pending: 0, active: 0, disabled: 0 };
    for (const m of members) c[m.status] += 1;
    return c;
  }, [members]);
  const rows = useMemo(
    () =>
      members
        .filter((m) => m.status === TAB_STATUS[tab])
        .filter((m) => query.filters.every((f) => matchesFilter(m, f)))
        .sort(compare(query.sort)),
    [members, tab, query.filters, query.sort],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / STAFF_PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(params.get(pageKey)) || 1), pageCount);
  const pageRows = rows.slice((page - 1) * STAFF_PAGE_SIZE, page * STAFF_PAGE_SIZE);

  // The open person: a change's answer until the list reloads after it, then the list's row.
  const listMember = members.find((m) => m.id === peek.openId) ?? null;
  const openMember =
    fresh && fresh.member.id === peek.openId && fresh.at > list.at ? fresh.member : listMember;
  const open = openMember !== null;

  const ids = rows.map((m) => m.id);
  const neighbours = peekNeighbours(ids, peek.openId);
  const goPrevious = neighbours.previousId
    ? () => peek.open(neighbours.previousId!, { replace: true })
    : undefined;
  const goNext = neighbours.nextId
    ? () => peek.open(neighbours.nextId!, { replace: true })
    : undefined;
  usePeekKeys({
    enabled: peekAvailable && open,
    onClose: peek.close,
    onPrevious: goPrevious,
    onNext: goNext,
  });

  function changed(member: StaffMember, message: string) {
    notifySuccess(message);
    setFresh({ member, at: Date.now() });
    refresh();
  }

  function setTab(next: string) {
    if (!isTab(next)) return;
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === 'people') updated.delete('tab');
        else updated.set('tab', next);
        updated.delete(pageKey);
        return updated;
      },
      { replace: false },
    );
  }

  function setPage(next: number) {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next <= 1) updated.delete(pageKey);
      else updated.set(pageKey, String(next));
      return updated;
    });
  }

  const columns = useStaffColumns(tab, currentUserId, (m) => peek.open(m.id));

  const drawerBody = (renderTitle: (name: string) => ReactNode, className?: string) =>
    openMember ? (
      <StaffDrawerBody
        key={openMember.id}
        member={openMember}
        isSelf={openMember.id === currentUserId}
        canAdmin={canAdmin}
        canPosition={canPosition}
        renderTitle={renderTitle}
        onChanged={changed}
        onForbidden={onForbidden}
        className={className}
      />
    ) : null;

  const capped = list.data && list.data.total > list.data.members.length;
  const listNode = (
    <TabsContent value={tab} className="flex min-h-full flex-col gap-3">
      <DataTable
        columns={columns}
        data={pageRows}
        getRowId={(m) => m.id}
        rowLabel={(m) => m.displayName}
        caption={`${TAB_LABELS[tab]} staff`}
        loading={list.data === null && !list.error}
        empty={
          tab === 'pending'
            ? 'No one is waiting for approval.'
            : tab === 'disabled'
              ? 'No disabled staff.'
              : 'No staff match these filters.'
        }
        onOpenRow={(m) => peek.open(m.id)}
        openRowId={open ? peek.openId : null}
        sort={query.sort}
        onSortChange={(sort) => setQuery({ sort })}
        freeColumnMin="14rem"
      />
      {tab === 'pending' ? (
        <p className="text-sm text-muted-foreground">
          Applicants appear here after their first Microsoft sign-in.
        </p>
      ) : tab === 'disabled' ? (
        <p className="text-sm text-muted-foreground">
          Open a person to re-enable them. Disabled people keep their name on past records.
        </p>
      ) : null}
      <StaffPager
        page={page}
        pageCount={pageCount}
        total={rows.length}
        onPage={setPage}
        noun={tab === 'pending' ? 'applicants' : 'people'}
      />
    </TabsContent>
  );

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <TabsList
          variant="line"
          aria-label="Staff by status"
          className="max-w-full overflow-x-auto"
        >
          {(Object.keys(TAB_LABELS) as StaffTab[]).map((key) => (
            <TabsTrigger key={key} value={key} className={TOUCH}>
              {TAB_LABELS[key]}{' '}
              <span className="font-mono text-[11px] text-muted-foreground">
                {list.data ? counts[TAB_STATUS[key]] : ''}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="ml-auto flex items-center gap-2">
          <TableToolbar
            label="Staff tools"
            query={query}
            onQueryChange={setQuery}
            filters={FILTERS}
            sortOptions={SORT_OPTIONS}
            sortLabels={SORT_LABELS}
            searchPlaceholder="Search staff…"
          />
          <Button type="button" size="sm" className={TOUCH} onClick={() => setAdding(true)}>
            <UserPlus aria-hidden="true" />
            Add staff
          </Button>
        </div>
      </div>

      {capped ? (
        <p role="status" className="text-sm text-stage-due-fg">
          Showing the first {list.data!.members.length} of {list.data!.total} staff. Search by name,
          initials or email to find the rest.
        </p>
      ) : null}
      {list.error && !list.error.forbidden ? (
        // A 403 hands over to StaffAccess's single message (MM-T52); don't show it twice.
        <ErrorAlert title="Staff couldn't load." onRetry={refresh}>
          {list.error.message}
        </ErrorAlert>
      ) : null}

      {peekAvailable ? (
        <PeekSplit
          className="h-[max(32rem,calc(100dvh-16rem))]"
          list={listNode}
          open={open}
          openId={open ? peek.openId : null}
          defaultSize="46%"
          minSize="36%"
          maxSize="65%"
          drawerLabelledBy={titleId}
          listLabel="Staff list"
          drawer={
            <>
              <PeekToolbar
                onClose={peek.close}
                position={{ index: neighbours.index, total: neighbours.total }}
                onPrevious={goPrevious}
                onNext={goNext}
              />
              {drawerBody((name) => (
                <h2 id={titleId} className="truncate text-lg font-semibold tracking-tight">
                  {name}
                </h2>
              ))}
            </>
          }
        />
      ) : (
        <>
          {listNode}
          <Sheet open={open} onOpenChange={(next) => (next ? undefined : peek.close())}>
            <SheetContent
              side="right"
              aria-describedby={undefined}
              className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg"
            >
              {drawerBody(
                (name) => (
                  <SheetTitle className="truncate text-lg font-semibold tracking-tight">
                    {name}
                  </SheetTitle>
                ),
                'pt-12 md:pt-12',
              )}
            </SheetContent>
          </Sheet>
        </>
      )}

      <AddStaffDialog
        open={adding}
        canPosition={canPosition}
        onForbidden={onForbidden}
        onClose={() => setAdding(false)}
        onAdded={(member) => {
          setAdding(false);
          changed(member, `${member.displayName} was added.`);
        }}
      />
    </Tabs>
  );
}

/** The footer pager: "1–20 of 22 people", Previous, page numbers, Next. Stays in view. */
function StaffPager({
  page,
  pageCount,
  total,
  noun,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  noun: string;
  onPage: (page: number) => void;
}) {
  const first = total === 0 ? 0 : (page - 1) * STAFF_PAGE_SIZE + 1;
  const last = Math.min(page * STAFF_PAGE_SIZE, total);
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1).filter(
    (n) => pageCount <= 7 || n === 1 || n === pageCount || Math.abs(n - page) <= 1,
  );
  return (
    <div className="sticky bottom-0 z-10 mt-auto flex flex-wrap items-center gap-3 border-t bg-background py-2">
      <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
        {total === 0 ? `0 ${noun}` : `${first}–${last} of ${total} ${noun}`}
      </p>
      {pageCount > 1 ? (
        <nav aria-label="Staff pages" className="ml-auto">
          <ul className="flex items-center gap-1">
            <li>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={TOUCH}
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => onPage(page - 1)}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
            </li>
            {pages.map((n, i) => (
              <li key={n} className="flex items-center gap-1">
                {i > 0 && n - pages[i - 1]! > 1 ? (
                  <span aria-hidden="true" className="px-1 text-muted-foreground">
                    …
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant={n === page ? 'outline' : 'ghost'}
                  size="icon-sm"
                  className={cn('tabular-nums', TOUCH)}
                  aria-label={`Page ${n}`}
                  aria-current={n === page ? 'page' : undefined}
                  onClick={() => onPage(n)}
                >
                  {n}
                </Button>
              </li>
            ))}
            <li>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={TOUCH}
                aria-label="Next page"
                disabled={page >= pageCount}
                onClick={() => onPage(page + 1)}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </li>
          </ul>
        </nav>
      ) : null}
    </div>
  );
}

/** The person cell: avatar and a name button named "Manage <name>". */
function PersonButton({
  member,
  isSelf,
  onOpen,
}: {
  member: StaffMember;
  isSelf: boolean;
  onOpen: () => void;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <PersonAvatar name={member.displayName} userId={member.id} />
      <Button
        type="button"
        variant="link"
        className="h-auto min-w-0 justify-start truncate p-0 font-medium text-foreground"
        title={member.displayName}
        // Contains the visible name (label in name), so voice control still works.
        aria-label={`Manage ${member.displayName}`}
        onClick={onOpen}
      >
        <span className="truncate">{member.displayName}</span>
      </Button>
      {isSelf ? <span className="shrink-0 text-xs text-muted-foreground">You</span> : null}
    </span>
  );
}

function RolesCell({ member }: { member: StaffMember }) {
  if (member.accountType === 'shared_lab') {
    return <span className="text-muted-foreground">Can't hold roles</span>;
  }
  if (member.roles.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <span className="flex min-w-0 gap-1 overflow-hidden">
      {member.roles.map((role) => (
        <Badge key={role} variant="secondary">
          {ROLE_LABELS[role]}
        </Badge>
      ))}
    </span>
  );
}

function useStaffColumns(
  tab: StaffTab,
  currentUserId: string,
  onOpen: (member: StaffMember) => void,
): DataTableColumn<StaffMember>[] {
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  });
  return useMemo(() => {
    const person: DataTableColumn<StaffMember> = {
      id: 'person',
      header: 'Person',
      priority: 'identity',
      sortKey: tab === 'people' ? 'name' : undefined,
      cell: (m) => (
        <PersonButton
          member={m}
          isSelf={m.id === currentUserId}
          onOpen={() => onOpenRef.current(m)}
        />
      ),
    };
    const status: DataTableColumn<StaffMember> = {
      id: 'status',
      header: 'Status',
      priority: 'state',
      width: '6rem',
      wrap: true,
      cell: (m) => <StaffStatusBadge status={m.status} />,
    };
    const position: DataTableColumn<StaffMember> = {
      id: 'position',
      header: 'Position',
      priority: 'attribute',
      width: '7rem',
      hideBelow: '40rem',
      sortKey: tab === 'people' ? 'position' : undefined,
      cell: (m) =>
        m.position ? (
          POSITION_LABELS[m.position]
        ) : (
          <span className="text-muted-foreground">Not set</span>
        ),
    };
    if (tab === 'pending') {
      return [
        person,
        {
          id: 'email',
          header: 'Work email',
          priority: 'attribute',
          hideBelow: '40rem',
          cell: (m) => m.signInUsername ?? m.workEmail ?? m.expectedUpn ?? '—',
        },
        {
          id: 'asked',
          header: 'Asked',
          priority: 'attribute',
          width: '10rem',
          hideBelow: '44rem',
          cell: (m) => when(m.createdAt),
        },
        status,
      ];
    }
    if (tab === 'disabled') {
      return [
        person,
        position,
        {
          id: 'disabled',
          header: 'Disabled',
          priority: 'attribute',
          width: '14rem',
          hideBelow: '46rem',
          wrap: true,
          cell: (m) => disabledText(m),
        },
        status,
      ];
    }
    return [
      person,
      position,
      {
        id: 'roles',
        header: 'Roles',
        priority: 'attribute',
        width: '10rem',
        cell: (m) => <RolesCell member={m} />,
      },
      {
        id: 'account',
        header: 'Account',
        priority: 'attribute',
        width: '6rem',
        hideBelow: '46rem',
        cell: (m) => ACCOUNT_LABELS[m.accountType],
      },
      {
        id: 'lastSignIn',
        header: 'Last sign-in',
        priority: 'attribute',
        width: '9rem',
        hideBelow: '46rem',
        sortKey: 'lastSignIn',
        cell: (m) => when(m.lastSignInAt),
      },
      status,
    ];
  }, [tab, currentUserId]);
}
