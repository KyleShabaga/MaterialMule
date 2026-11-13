import {
  TABLE_COLUMN_REGISTRY,
  inboxAge,
  type DateFormatPreference,
  type InboxItem,
  type InboxPage as InboxPageData,
  type InboxSort,
  type InboxTab,
  type InboxView,
} from '@materialmule/shared';
import {
  CheckCheck,
  Clock,
  Columns3,
  Folder,
  Hash,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  SearchX,
  Tag,
  Type,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DataTable, type DataTableColumn } from '../components/strata/data-table';
import {
  PeekSplit,
  PeekToolbar,
  peekNeighbours,
  usePeekAvailable,
  usePeekKeys,
  usePeekParam,
} from '../components/strata/peek';
import { PersonCell } from '../components/strata/person-avatar';
import { StageStripe } from '../components/strata/stage-stripe';
import { notifyError, notifySuccess } from '../components/strata/toast';
import { TableToolbar } from '../components/strata/table-toolbar';
import { useTableQuery, type TableQuery } from '../components/strata/table-query';
import { useDebounced } from '../projects/project-format';
import { LoadErrorAlert, TablePager } from '../projects/project-ui';
import { useMe } from '../session/context';
import { useRecordingPerson } from '../session/recording-person';
import { usePersonPreferences } from '../settings/account/preferences-api';
import {
  InboxForbiddenError,
  bulkInbox,
  fetchInboxColumns,
  fetchInboxPage,
  findInboxItem,
  inboxRequestParams,
  markAllInboxRead,
  markItemRead,
  markRequest,
  rememberInboxItems,
  saveInboxColumns,
  seenInboxItem,
  updateAction,
  type InboxBulkAction,
  type InboxColumnsState,
} from './inbox-api';
import { InboxItemDetail, KindIcon, KindLabel, type InboxItemActions } from './InboxItemDetail';
import {
  FILTER_OPTIONS,
  SORT_LABELS,
  SORT_OPTIONS,
  TAB_LABELS,
  VIEW_OPTIONS,
  fromName,
  groupedSections,
  inboxFilters,
  inboxItemPath,
  inboxSort,
  kindText,
  readInboxPage,
  readInboxTab,
  readInboxView,
  shownOrder,
  streamSections,
  type InboxSection,
} from './inbox-model';
import { StationInbox } from './station-inbox/StationInbox';

// Inbox (STRATA-24, 26, 64; DESIGN.md › Inbox): every action request and update in one place,
// with tabs, the table tools, three views and a drawer beside the list. Reading, dismissing or
// opening an item never resolves a request: requests close on their own when the real work is
// done on the record they point to.

const TABS: readonly InboxTab[] = ['all', 'requests', 'updates', 'done'];

/** Table view headings: a 14 px Lucide icon before each muted label. */
function Heading({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

function UnreadMark({ item }: { item: InboxItem }) {
  if (!item.unread) return null;
  return (
    <>
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />
      <span className="sr-only">Unread: </span>
    </>
  );
}

function Age({
  item,
  now,
  dateFormat,
}: {
  item: InboxItem;
  now: Date;
  dateFormat?: DateFormatPreference;
}) {
  return <time dateTime={item.receivedAt}>{inboxAge(item.receivedAt, now, dateFormat)}</time>;
}

/** What this page changes on an item before the next load lands. */
type ItemPatch = { unread?: boolean; dismissed?: boolean };

type Load =
  | { key: string; state: 'ready'; data: InboxPageData }
  | { key: string; state: 'error'; forbidden: boolean };

/** The page: a LAB station shows the picked person's Inbox (STRATA-27); everyone else their own. */
export function InboxPage() {
  const { isStation } = useRecordingPerson();
  if (isStation) return <StationInbox />;
  return <PersonalInbox />;
}

function PersonalInbox() {
  const me = useMe();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const prefs = usePersonPreferences();
  const peek = usePeekParam();
  const peekAvailable = usePeekAvailable();

  const tab = readInboxTab(params);
  const page = readInboxPage(params);
  const filters = inboxFilters(query.filters);
  const sort: InboxSort = inboxSort(query.sort);
  const view: InboxView = readInboxView(query.view) ?? prefs.preferences.inboxView;
  const dateFormat = prefs.preferences.dateFormat;
  const search = useDebounced(query.search);

  const requestKey = inboxRequestParams({ tab, filters, q: search, sort, page }).toString();
  const [load, setLoad] = useState<Load | null>(null);
  const [reloads, setReloads] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    fetchInboxPage(new URLSearchParams(requestKey)).then(
      (data) => {
        if (!active) return;
        rememberInboxItems(me.id, data.items);
        setNow(new Date());
        setLoad({ key: requestKey, state: 'ready', data });
      },
      (error: unknown) => {
        if (active) {
          setLoad({
            key: requestKey,
            state: 'error',
            forbidden: error instanceof InboxForbiddenError,
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [requestKey, reloads, me.id]);

  // Keep the last page on screen while the next one loads, so the list doesn't flash.
  const loading = load?.key !== requestKey;
  const data = load?.state === 'ready' ? load.data : null;
  const items = useMemo(() => data?.items ?? [], [data]);

  // Items changed here before the next load lands (read, unread, dismissed).
  const [patches, setPatches] = useState<Record<string, ItemPatch>>({});
  const patched = useCallback(
    (item: InboxItem): InboxItem =>
      patches[item.key] ? ({ ...item, ...patches[item.key] } as InboxItem) : item,
    [patches],
  );
  const patch = useCallback((key: string, change: ItemPatch) => {
    setPatches((current) => ({ ...current, [key]: { ...current[key], ...change } }));
  }, []);
  const shown = useMemo(() => items.map(patched), [items, patched]);

  const sections: InboxSection[] = useMemo(() => {
    if (view === 'grouped') return groupedSections(shown, tab);
    if (view === 'table') return shown.length ? [{ id: 'table', heading: '', items: shown }] : [];
    return streamSections(shown, sort, now, dateFormat);
  }, [view, shown, tab, sort, now, dateFormat]);
  const order = useMemo(() => shownOrder(sections), [sections]);

  // ---- The drawer ----
  const openKey = peek.openId;
  const drawerOpen = openKey !== null && peekAvailable;
  const [held, setHeld] = useState<InboxItem | null>(null);
  const listed = openKey ? (shown.find((item) => item.key === openKey) ?? null) : null;
  const openItem =
    listed ??
    (openKey && held?.key === openKey ? patched(held) : null) ??
    (openKey ? seenFor(me.id, openKey, patched) : null);

  // A link straight to ?open=<key> whose item isn't on this page: find it in the feed.
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => {
    if (!openKey || openItem || !data) return;
    let active = true;
    findInboxItem(openKey).then(
      (found) => {
        if (!active) return;
        if (found) setHeld(found);
        else setMissing(openKey);
      },
      () => {
        if (active) setMissing(openKey);
      },
    );
    return () => {
      active = false;
    };
  }, [openKey, openItem, data]);

  // Under 1024 px there is no drawer: ?open= goes to the full page instead.
  useEffect(() => {
    if (openKey && !peekAvailable) {
      void navigate(inboxItemPath(openKey), { replace: true, state: { item: openItem } });
    }
  }, [openKey, peekAvailable, navigate, openItem]);

  // Opening an unread item marks it read, once per opening (Mark unread then stays unread).
  const markedRef = useRef(new Set<string>());
  // Items the person marked unread here: opening them again leaves them unread.
  const [keptUnread, setKeptUnread] = useState<ReadonlySet<string>>(new Set());
  const keepUnread = useCallback((keys: readonly string[]) => {
    setKeptUnread((current) => new Set([...current, ...keys]));
  }, []);
  useEffect(() => {
    if (!drawerOpen || !openItem) return;
    if (!openItem.unread || keptUnread.has(openItem.key)) return;
    if (markedRef.current.has(openItem.key)) return;
    markedRef.current.add(openItem.key);
    const item = openItem;
    void markItemRead(item).then((ok) => {
      if (ok) {
        patch(item.key, { unread: false });
        reload();
      }
    });
  }, [drawerOpen, openItem, patch, reload, keptUnread]);
  useEffect(() => {
    if (!openKey) markedRef.current.clear();
  }, [openKey]);

  const openRow = (item: InboxItem) => {
    if (!peekAvailable) {
      void navigate(inboxItemPath(item.key), { state: { item } });
      return;
    }
    setHeld(item);
    peek.open(item.key);
  };

  const neighbours = peekNeighbours(order, openKey);
  const goTo = (key: string | null) => {
    if (!key) return;
    const item = shown.find((i) => i.key === key);
    if (item) setHeld(item);
    peek.open(key);
  };
  usePeekKeys({
    enabled: drawerOpen,
    onClose: peek.close,
    onPrevious: neighbours.previousId ? () => goTo(neighbours.previousId) : undefined,
    onNext: neighbours.nextId ? () => goTo(neighbours.nextId) : undefined,
  });

  // ---- Item actions ----
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<boolean>, failed: string) => {
    setBusy(true);
    const ok = await work();
    setBusy(false);
    if (!ok) notifyError(failed, 'Check the connection and try again.');
    return ok;
  };

  const actionsFor = (item: InboxItem): InboxItemActions => {
    if (item.type === 'request') {
      return {
        busy,
        onMarkUnread: () => {
          void run(
            async () => (await markRequest(item.sourceId, false)) !== null,
            'It wasn’t marked unread.',
          ).then((ok) => {
            if (!ok) return;
            keepUnread([item.key]);
            patch(item.key, { unread: true });
            notifySuccess('Marked unread');
            reload();
          });
        },
      };
    }
    const restore = async () => {
      if (!(await updateAction(item.sourceId, 'restore'))) throw new Error('It wasn’t restored.');
      patch(item.key, { dismissed: false });
      reload();
    };
    return {
      busy,
      onDismiss: () => {
        void run(() => updateAction(item.sourceId, 'dismiss'), 'It wasn’t dismissed.').then(
          (ok) => {
            if (!ok) return;
            patch(item.key, { dismissed: true, unread: false });
            notifySuccess('Dismissed', { undo: { run: restore, doneMessage: 'Restored' } });
            reload();
          },
        );
      },
      onRestore: () => {
        void run(async () => {
          try {
            await restore();
            return true;
          } catch {
            return false;
          }
        }, 'It wasn’t restored.').then((ok) => {
          if (ok) notifySuccess('Restored');
        });
      },
    };
  };

  const markAll = async () => {
    const summary = await markAllInboxRead();
    if (!summary) {
      notifyError('Nothing was marked read.', 'Check the connection and try again.');
      return;
    }
    setPatches((current) => {
      const next = { ...current };
      for (const item of items) next[item.key] = { ...next[item.key], unread: false };
      return next;
    });
    notifySuccess('Everything is marked read');
    reload();
  };

  // ---- Tabs, toolbar, view ----
  const chooseTab = (next: string) => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === 'all') updated.delete('tab');
      else updated.set('tab', next);
      updated.delete('page');
      updated.delete('open');
      return updated;
    });
  };
  const goToPage = (next: number) => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next > 1) updated.set('page', String(next));
      else updated.delete('page');
      return updated;
    });
  };

  const toolbarQuery: TableQuery = { ...query, view };
  const onQueryChange = (change: Partial<TableQuery>) => {
    const { view: nextView, ...rest } = change;
    if ('view' in change) {
      const chosen = readInboxView(nextView ?? null) ?? 'stream';
      // The page's choice is the person's Inbox view (Settings › Preferences shows the same).
      if (chosen !== prefs.preferences.inboxView) void prefs.update({ inboxView: chosen });
      setQuery({ ...rest, view: null });
      return;
    }
    setQuery(rest);
  };

  // ---- Table columns (STRATA-51) ----
  const [columnsState, setColumnsState] = useState<InboxColumnsState | null>(null);
  useEffect(() => {
    if (view !== 'table' || columnsState) return;
    let active = true;
    void fetchInboxColumns().then((state) => {
      if (active && state) setColumnsState(state);
    });
    return () => {
      active = false;
    };
  }, [view, columnsState]);
  const hidden = columnsState?.hidden ?? [];
  const toggleColumn = async (id: string, show: boolean) => {
    if (!columnsState || columnsState.readOnly) return;
    const before = columnsState;
    const next = show ? before.hidden.filter((c) => c !== id) : [...before.hidden, id];
    setColumnsState({ ...before, hidden: next });
    const result = await saveInboxColumns(next, before.version);
    if (result.kind === 'saved') setColumnsState(result.state);
    else if (result.kind === 'conflict') {
      setColumnsState(result.state);
      notifyError('Someone changed these columns on another computer; showing the latest.');
    } else {
      setColumnsState(before);
      notifyError('That column change wasn’t saved.', 'Check the connection and try again.');
    }
  };

  // ---- Checked rows (STRATA-48, Table view only) ----
  const selectionScope = `${requestKey}|${view}`;
  const [selection, setSelection] = useState<{ scope: string; ids: Set<string> }>({
    scope: selectionScope,
    ids: new Set(),
  });
  const selectedIds = selection.scope === selectionScope ? selection.ids : new Set<string>();
  const setSelectedIds = (ids: Set<string>) => setSelection({ scope: selectionScope, ids });
  const runBulk = async (action: InboxBulkAction) => {
    const keys = order.filter((key) => selectedIds.has(key));
    if (keys.length === 0) return;
    setBusy(true);
    const outcome = await bulkInbox(action, keys);
    setBusy(false);
    if (!outcome.ok) {
      notifyError(
        outcome.code === 'dismiss_requests'
          ? 'Requests can’t be dismissed. They close on their own when the work is done.'
          : 'Those changes weren’t saved.',
        outcome.code === 'dismiss_requests' ? undefined : 'Check the connection and try again.',
      );
      return;
    }
    const { updated, failed } = outcome.result;
    if (action === 'unread') keepUnread(keys.filter((key) => !failed.includes(key)));
    for (const key of keys) {
      if (failed.includes(key)) continue;
      patch(
        key,
        action === 'dismiss' ? { dismissed: true, unread: false } : { unread: action === 'unread' },
      );
    }
    if (failed.length > 0) {
      notifyError(
        `${updated} of ${keys.length} updated`,
        'The others changed meanwhile or couldn’t be saved.',
      );
    } else {
      notifySuccess(
        action === 'read'
          ? `${updated} marked read`
          : action === 'unread'
            ? `${updated} marked unread`
            : `${updated} dismissed`,
      );
    }
    setSelectedIds(new Set());
    reload();
  };

  // ---- Render ----
  const drawerTitleId = useId();
  const counts = data?.tabCounts;
  const unreadTotal = data?.summary.counts.unread ?? 0;
  const searching = query.search.trim() !== '' || filters.length > 0;

  let body: ReactNode;
  if (load?.state === 'error' && !loading) {
    body = load.forbidden ? (
      <Alert>
        <InboxIcon aria-hidden="true" />
        <AlertTitle>Inbox is for personal accounts.</AlertTitle>
        <AlertDescription>
          Sign in with your own account to see your requests and updates.
        </AlertDescription>
      </Alert>
    ) : (
      <LoadErrorAlert
        title="Inbox couldn’t load"
        message="Check the connection and try again."
        onRetry={reload}
      />
    );
  } else if (data && data.total === 0 && !loading) {
    body = (
      <EmptyInbox
        tab={tab}
        searching={searching}
        onClear={() => setQuery({ search: '', filters: [] })}
      />
    );
  } else if (view === 'table') {
    body = (
      <InboxTable
        items={shown}
        loading={!data && loading}
        drawerOpen={drawerOpen}
        hidden={hidden}
        sort={query.sort}
        onSortChange={(next) => setQuery({ sort: next })}
        onOpen={openRow}
        openKey={drawerOpen ? openKey : null}
        now={now}
        dateFormat={dateFormat}
        selectedIds={selectedIds}
        onSelectedIdsChange={setSelectedIds}
      />
    );
  } else {
    body = (
      <InboxStream
        sections={sections}
        loading={!data && loading}
        openKey={drawerOpen ? openKey : null}
        onOpen={openRow}
        now={now}
        dateFormat={dateFormat}
      />
    );
  }

  const checked = order.filter((key) => selectedIds.has(key));
  const checkedItems = shown.filter((item) => selectedIds.has(item.key));
  const allUpdates =
    checkedItems.length > 0 && checkedItems.every((item) => item.type === 'update');
  const allRequests =
    checkedItems.length > 0 && checkedItems.every((item) => item.type === 'request');

  const list = (
    <div className="flex min-w-0 flex-col gap-3 p-1">
      <h1 className="sr-only">Inbox</h1>
      <Tabs value={tab} onValueChange={chooseTab}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList
            aria-label="Inbox"
            className="max-w-full justify-start overflow-x-auto overflow-y-hidden"
          >
            {TABS.map((id) => (
              <TabsTrigger
                key={id}
                value={id}
                // MTR-131: a Windows contrast theme flattens the active fill; use the highlight.
                className="forced-colors:data-[state=active]:bg-[Highlight] forced-colors:data-[state=active]:text-[HighlightText] forced-colors:data-[state=active]:forced-color-adjust-none"
              >
                {TAB_LABELS[id]}
                {counts ? (
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums forced-colors:text-inherit">
                    {' '}
                    {counts[id].toLocaleString('en-CA')}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex items-center gap-0.5">
            {view === 'table' ? (
              <ColumnsMenu
                hidden={hidden}
                disabled={!columnsState || columnsState.readOnly}
                onToggle={(id, show) => void toggleColumn(id, show)}
              />
            ) : null}
            <TableToolbar
              label="Inbox tools"
              query={toolbarQuery}
              onQueryChange={onQueryChange}
              pageAction={{
                label: 'Mark all read',
                icon: CheckCheck,
                onClick: () => void markAll(),
                disabled: !data || unreadTotal === 0,
              }}
              filters={FILTER_OPTIONS}
              sortOptions={SORT_OPTIONS}
              sortLabels={SORT_LABELS}
              views={VIEW_OPTIONS}
              searchPlaceholder="Search Inbox…"
            />
          </div>
        </div>
      </Tabs>
      {view === 'table' && checked.length > 0 ? (
        <div
          role="toolbar"
          aria-label="Checked rows"
          className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm"
        >
          <span className="font-medium tabular-nums">{checked.length} checked</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void runBulk('read')}>
            <MailOpen aria-hidden="true" />
            Mark read
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !allRequests}
            aria-describedby={allRequests ? undefined : 'inbox-bulk-unread-hint'}
            onClick={() => void runBulk('unread')}
          >
            <Mail aria-hidden="true" />
            Mark unread
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !allUpdates}
            aria-describedby={allUpdates ? undefined : 'inbox-bulk-dismiss-hint'}
            onClick={() => void runBulk('dismiss')}
          >
            <X aria-hidden="true" />
            Dismiss
          </Button>
          {!allRequests ? (
            <span id="inbox-bulk-unread-hint" className="text-xs text-muted-foreground">
              Updates stay read once opened.
            </span>
          ) : null}
          {!allUpdates ? (
            <span id="inbox-bulk-dismiss-hint" className="text-xs text-muted-foreground">
              Only updates can be dismissed. Requests close on their own.
            </span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}
      <div aria-busy={loading} className="min-w-0">
        {body}
      </div>
      {data && !(load?.state === 'error') ? (
        <TablePager
          page={page}
          pageSize={data.pageSize}
          total={data.total}
          noun={data.total === 1 ? 'item' : 'items'}
          onPage={goToPage}
        />
      ) : null}
    </div>
  );

  let drawer: ReactNode = null;
  if (drawerOpen) {
    drawer = (
      <>
        <PeekToolbar
          onClose={peek.close}
          fullPageHref={inboxItemPath(openKey)}
          position={{ index: neighbours.index, total: neighbours.total }}
          onPrevious={neighbours.previousId ? () => goTo(neighbours.previousId) : undefined}
          onNext={neighbours.nextId ? () => goTo(neighbours.nextId) : undefined}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {openItem ? (
            <InboxItemDetail
              item={openItem}
              titleId={drawerTitleId}
              now={now}
              dateFormat={dateFormat}
              actions={actionsFor(openItem)}
            />
          ) : missing === openKey ? (
            <div className="flex flex-col gap-1 p-5 text-sm">
              <p className="font-medium">Select an item to see it here.</p>
              <p className="text-muted-foreground">
                The item in this link isn’t in your Inbox any more. Inbox keeps 90 days.
              </p>
            </div>
          ) : (
            <p className="p-5 text-sm text-muted-foreground">Loading…</p>
          )}
        </div>
      </>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <PeekSplit
        className="h-full min-h-0"
        open={drawerOpen}
        openId={drawerOpen ? openKey : null}
        listLabel="Inbox"
        drawerLabelledBy={openItem ? drawerTitleId : undefined}
        drawerLabel="Inbox item"
        list={list}
        drawer={drawer}
      />
    </TooltipProvider>
  );
}

function seenFor(
  personId: string,
  key: string,
  patched: (item: InboxItem) => InboxItem,
): InboxItem | null {
  const item = seenInboxItem(personId, key);
  return item ? patched(item) : null;
}

function EmptyInbox({
  tab,
  searching,
  onClear,
}: {
  tab: InboxTab;
  searching: boolean;
  onClear: () => void;
}) {
  if (searching) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Nothing matches.</EmptyTitle>
          <EmptyDescription>Change the search or the filters, or clear them.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={onClear}>
            Clear search and filters
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  const title =
    tab === 'requests'
      ? 'Nothing is waiting on you.'
      : tab === 'updates'
        ? 'You have read every notification.'
        : tab === 'done'
          ? 'Nothing done in the last 90 days.'
          : 'Your Inbox is empty.';
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <InboxIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>
          Requests close on their own when the work is done on the record they point to.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

// ---------------------------------------------------------------------------------------------
// One stream and Grouped.

function InboxStream({
  sections,
  loading,
  openKey,
  onOpen,
  now,
  dateFormat,
}: {
  sections: InboxSection[];
  loading: boolean;
  openKey: string | null;
  onOpen: (item: InboxItem) => void;
  now: Date;
  dateFormat?: DateFormatPreference;
}) {
  if (loading) return <p className="px-3 py-6 text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="flex flex-col gap-4">
      {sections.map((section) => (
        <section
          key={section.id}
          aria-labelledby={section.heading ? `inbox-day-${section.id}` : undefined}
        >
          {section.heading ? (
            <h2
              id={`inbox-day-${section.id}`}
              className="px-3 pb-1 text-[13px] font-semibold text-muted-foreground"
            >
              {section.heading}
            </h2>
          ) : null}
          <ul aria-label={section.heading || 'Inbox'} className="flex flex-col">
            {section.items.map((item) => (
              <InboxRow
                key={item.key}
                item={item}
                open={openKey === item.key}
                onOpen={() => onOpen(item)}
                now={now}
                dateFormat={dateFormat}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function InboxRow({
  item,
  open,
  onOpen,
  now,
  dateFormat,
}: {
  item: InboxItem;
  open: boolean;
  onOpen: () => void;
  now: Date;
  dateFormat?: DateFormatPreference;
}) {
  return (
    <li aria-label={item.title} className="relative">
      <button
        type="button"
        data-slot="inbox-row"
        data-peek-id={item.key}
        aria-current={open ? 'true' : undefined}
        onClick={onOpen}
        className="relative flex w-full items-start gap-3 rounded-md py-2.5 pr-3 pl-4 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=true]:bg-accent pointer-coarse:min-h-11"
      >
        <StageStripe stage={item.stage} variant="row" />
        <KindIcon item={item} className="mt-0.5 size-6" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <KindLabel item={item} />
            {item.jobNumber ? <span className="shrink-0 font-mono">{item.jobNumber}</span> : null}
          </span>
          <span className={cn('min-w-0 text-sm text-foreground', item.unread && 'font-semibold')}>
            {item.unread ? <span className="sr-only">Unread: </span> : null}
            {item.title}
          </span>
          <span className="text-xs text-muted-foreground">
            {fromName(item)} · <Age item={item} now={now} dateFormat={dateFormat} />
            {item.type === 'update' && item.dismissed ? ' · Dismissed' : null}
          </span>
        </span>
        {item.unread ? (
          <span aria-hidden="true" className="mt-2 size-2 shrink-0 rounded-full bg-primary" />
        ) : null}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Table (28 px rows, Notion borders on this view only; STRATA-64 with the drawer open).

const OPTIONAL_COLUMNS = TABLE_COLUMN_REGISTRY.inbox;

function ColumnsMenu({
  hidden,
  disabled,
  onToggle,
}: {
  hidden: readonly string[];
  disabled: boolean;
  onToggle: (id: string, show: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Columns"
              className="text-muted-foreground hover:text-accent-foreground data-[state=open]:bg-accent"
            >
              <Columns3 aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Columns</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Columns</DropdownMenuLabel>
        {OPTIONAL_COLUMNS.map((column) =>
          column.required ? (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked
              disabled
              aria-label={`${column.label}, always shown`}
            >
              <span className="flex-1">{column.label}</span>
              <span className="text-xs text-muted-foreground">Always shown</span>
            </DropdownMenuCheckboxItem>
          ) : (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={!hidden.includes(column.id)}
              disabled={disabled}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(on) => onToggle(column.id, on === true)}
            >
              {column.label}
            </DropdownMenuCheckboxItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InboxTable({
  items,
  loading,
  drawerOpen,
  hidden,
  sort,
  onSortChange,
  onOpen,
  openKey,
  now,
  dateFormat,
  selectedIds,
  onSelectedIdsChange,
}: {
  items: InboxItem[];
  loading: boolean;
  drawerOpen: boolean;
  hidden: readonly string[];
  sort: TableQuery['sort'];
  onSortChange: (next: TableQuery['sort']) => void;
  onOpen: (item: InboxItem) => void;
  openKey: string | null;
  now: Date;
  dateFormat?: DateFormatPreference;
  selectedIds: ReadonlySet<string>;
  onSelectedIdsChange: (next: Set<string>) => void;
}) {
  const columns = useMemo<DataTableColumn<InboxItem>[]>(() => {
    const kind: DataTableColumn<InboxItem> = {
      id: 'kind',
      header: <span className="sr-only">Kind</span>,
      priority: 'identity',
      gutter: true,
      control: drawerOpen,
      width: '1.25rem',
      cell: (item) =>
        drawerOpen ? (
          // STRATA-64: with the drawer open, Task folds into the kind icon.
          <Tooltip>
            <TooltipTrigger asChild>
              <span data-fold="task" className="inline-flex">
                <KindIcon item={item} />
                <span className="sr-only">{kindText(item)}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{kindText(item)}</TooltipContent>
          </Tooltip>
        ) : (
          <KindIcon item={item} />
        ),
    };
    const task: DataTableColumn<InboxItem> = {
      id: 'task',
      header: <Heading icon={Tag}>Task</Heading>,
      priority: 'state',
      width: '10rem',
      sortKey: 'task',
      cell: (item) => <KindLabel item={item} />,
    };
    const title: DataTableColumn<InboxItem> = {
      id: 'title',
      header: <Heading icon={Type}>Title</Heading>,
      priority: 'identity',
      sortKey: 'title',
      cell: (item) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <UnreadMark item={item} />
          <span className={cn('truncate', item.unread && 'font-semibold')} title={item.title}>
            {item.title}
          </span>
        </span>
      ),
    };
    const job: DataTableColumn<InboxItem> = {
      id: 'job_number',
      header: <Heading icon={Folder}>Job number</Heading>,
      // With the drawer open it hides below a 30rem list (a container query on the list).
      priority: drawerOpen ? 'attribute' : 'identity',
      hideBelow: drawerOpen ? '30rem' : undefined,
      mono: true,
      width: '7rem',
      sortKey: 'job_number',
      cell: (item) => item.jobNumber ?? <span className="text-muted-foreground">—</span>,
    };
    const record: DataTableColumn<InboxItem> = {
      id: 'record',
      header: <Heading icon={Hash}>Record</Heading>,
      priority: 'attribute',
      width: '9rem',
      sortKey: 'record',
      cell: (item) =>
        item.record ? (
          <span className="block truncate font-mono" title={item.record.label}>
            {item.record.label}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    };
    const from: DataTableColumn<InboxItem> = {
      id: 'from',
      header: <Heading icon={User}>From</Heading>,
      priority: 'attribute',
      width: '8rem',
      sortKey: 'from',
      cell: (item) => (
        <PersonCell
          name={item.from?.name ?? null}
          userId={item.from?.userId ?? null}
          system={!item.from}
          size="compact"
        />
      ),
    };
    const received: DataTableColumn<InboxItem> = {
      id: 'received',
      header: <Heading icon={Clock}>Received</Heading>,
      priority: 'attribute',
      width: '7rem',
      sortKey: 'received',
      cell: (item) => <Age item={item} now={now} dateFormat={dateFormat} />,
    };
    if (drawerOpen) return [kind, title, job];
    return [kind, task, title, job, record, from, received].filter(
      (column) => !hidden.includes(column.id),
    );
  }, [drawerOpen, hidden, now, dateFormat]);

  return (
    <DataTable
      columns={columns}
      data={items}
      getRowId={(item) => item.key}
      rowLabel={(item) => item.title}
      density="table"
      sort={sort}
      onSortChange={onSortChange}
      stage={(item) => item.stage}
      selectedIds={selectedIds}
      onSelectedIdsChange={onSelectedIdsChange}
      onOpenRow={onOpen}
      openRowId={openKey}
      caption="Inbox"
      loading={loading}
    />
  );
}
