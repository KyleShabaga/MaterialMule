import { Command as CommandPrimitive } from 'cmdk';
import { ArrowLeft, CircleHelp, Keyboard, LayoutList, Search } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { displayScannedValue } from '../scanning/scan-core';
import { useSession } from '../session/context';
import { exactDestination, resolveExact, resultsPath } from './api';
import {
  MENU_LABEL,
  MENU_MAX_QUERY,
  MENU_PLACEHOLDER,
  MENU_PREVIEW,
  NO_MATCH,
  normalizeQuery,
  useLiveSearch,
  useMenuShortcuts,
} from './menu-behaviour';
import {
  commandShortcutLabel,
  matchesLabel,
  menuActions,
  menuPages,
  type MenuLink,
} from './menu-items';
import { concreteSetRows, projectRow, unitRow } from './rows';
import { useScanAnywhere } from './scan-anywhere';
import { StageTag } from './StageTag';

export interface CommandMenuController {
  /** Opens the Ctrl K command menu, optionally with a query already typed (a scan, a search). */
  open(initialQuery?: string): void;
  close(): void;
  toggle(): void;
  isOpen: boolean;
}

const CommandMenuContext = createContext<CommandMenuController | null>(null);

type View = 'search' | 'shortcuts';

interface MenuState {
  open: boolean;
  query: string;
  view: View;
}

/** Router state that /sample-storage/scan's desktop redirect leaves, so the menu can say why. */
export interface ScanRedirectState {
  scanRedirect: true;
}

/**
 * Owns the one CommandDialog open state for the sidebar's "Search or scan" field, Ctrl K / ⌘K,
 * "/", Quick actions › Scan and scan-anywhere. Rendered once by the shell (AppLayout), inside the
 * router and the active session.
 */
export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MenuState>({ open: false, query: '', view: 'search' });
  const navigate = useNavigate();

  const open = useCallback(
    (initialQuery?: string) => setState({ open: true, query: initialQuery ?? '', view: 'search' }),
    [],
  );
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const toggle = useCallback(
    () =>
      setState((s) => (s.open ? { ...s, open: false } : { open: true, query: '', view: 'search' })),
    [],
  );

  useMenuShortcuts({
    toggle,
    open,
    openShortcuts: () => setState({ open: true, query: '', view: 'shortcuts' }),
  });

  // DESIGN.md › UX changes 1: a wedge read with nothing focused opens that unit or shelf.
  useScanAnywhere({
    onScan: (value) => {
      toast(`Scanned ${displayScannedValue(value)}`);
      void resolveExact(value).then((exact) => {
        void navigate(exactDestination(exact) ?? resultsPath(value));
      });
    },
  });

  const value = useMemo<CommandMenuController>(
    () => ({ open, close, toggle, isOpen: state.open }),
    [open, close, toggle, state.open],
  );
  return (
    <CommandMenuContext.Provider value={value}>
      {children}
      <CommandMenuDialog
        open={state.open}
        onOpenChange={(next) => (next ? open() : close())}
        initialQuery={state.query}
        initialView={state.view}
        onClose={close}
      />
    </CommandMenuContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- fixed contract export
export function useCommandMenu(): CommandMenuController {
  const value = useContext(CommandMenuContext);
  if (!value) throw new Error('useCommandMenu must be used inside <CommandMenuProvider>');
  return value;
}

/** The controller when the shell provides one; null outside it (no throw). */
// eslint-disable-next-line react-refresh/only-export-components -- the hook sits by its context
export function useOptionalCommandMenu(): CommandMenuController | null {
  return useContext(CommandMenuContext);
}

const COMMAND_CLASSES =
  '**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2';

/**
 * shadcn's CommandDialog, composed from the same parts because the menu filters on the server:
 * cmdk's own fuzzy filter is off (`shouldFilter={false}`) so server matches are never hidden or
 * reordered on the client.
 */
function CommandMenuDialog({
  open,
  onOpenChange,
  initialQuery,
  initialView,
  onClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialQuery: string;
  initialView: View;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-command-menu=""
        className="top-[15%] translate-y-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search or scan</DialogTitle>
          <DialogDescription>
            Find storage units, projects, actions and pages, or scan a label.
          </DialogDescription>
        </DialogHeader>
        <MenuBody initialQuery={initialQuery} initialView={initialView} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted each time the menu opens, so it starts from that opening's query and view. */
function MenuBody({
  initialQuery,
  initialView,
  onClose,
}: {
  initialQuery: string;
  initialView: View;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { session } = useSession();
  const me = session.status === 'active' ? session.me : null;
  const [view, setView] = useState<View>(initialView);
  const [query, setQuery] = useState(initialQuery);
  const q = normalizeQuery(query);
  const canRead = !!me?.permissions.includes('inventory.read');
  const { results, loading } = useLiveSearch(q, {
    canRead,
    immediateFor: normalizeQuery(initialQuery) || undefined,
  });
  const [resolving, setResolving] = useState(false);
  /** Arrow keys moved the highlight: Enter then picks that row instead of an exact lookup. */
  const moved = useRef(false);
  const submitToken = useRef(0);
  const redirected = (location.state as Partial<ScanRedirectState> | null)?.scanRedirect === true;

  const go = useCallback(
    (to: string) => {
      onClose();
      void navigate(to);
    },
    [navigate, onClose],
  );

  async function submitExact(text: string) {
    const token = ++submitToken.current;
    setResolving(true);
    const exact = await resolveExact(text);
    if (token !== submitToken.current) return;
    setResolving(false);
    go(exactDestination(exact) ?? resultsPath(text));
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') moved.current = true;
    if (event.key !== 'Enter' || !q || moved.current) return;
    // A typed or scanned ID: the exact lookup decides, never whichever row is highlighted.
    event.preventDefault();
    void submitExact(q);
  }

  const actions = me ? menuActions(me) : [];
  const pages = me ? menuPages(me) : [];
  const help: MenuLink[] = [
    { key: 'shortcuts', label: 'Keyboard shortcuts', to: '#shortcuts', icon: Keyboard },
    { key: 'help', label: 'Help and how-tos', to: '/help', icon: CircleHelp },
  ];
  const filter = (links: MenuLink[]) => (q ? links.filter((l) => matchesLabel(l.label, q)) : links);
  const shownActions = filter(actions);
  const shownPages = filter(pages);
  const shownHelp = filter(help);

  if (view === 'shortcuts') {
    return <ShortcutsView onBack={() => setView('search')} />;
  }

  const units = results?.units?.ok ? results.units.data : null;
  const projects = results?.projects?.ok ? results.projects.data : [];
  const concrete = results?.concrete?.ok ? concreteSetRows(results.concrete.data) : [];
  const failures = results
    ? [results.units, results.projects, results.concrete].filter(
        (r): r is { ok: false; forbidden: false; message: string } => !!r && !r.ok && !r.forbidden,
      )
    : [];
  const recordCount = (units?.items.length ?? 0) + projects.length + concrete.length;
  const nothing =
    !!q &&
    !loading &&
    recordCount === 0 &&
    failures.length === 0 &&
    shownActions.length + shownPages.length + shownHelp.length === 0;

  return (
    <CommandPrimitive
      data-slot="command"
      shouldFilter={false}
      // Ctrl K must close the menu, not move the highlight (cmdk's vim keys use Ctrl J/K/N/P).
      vimBindings={false}
      loop
      label={MENU_LABEL}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
        COMMAND_CLASSES,
      )}
    >
      <CommandInput
        placeholder={MENU_PLACEHOLDER}
        value={query}
        onValueChange={(next) => {
          moved.current = false;
          // A new query cancels an exact lookup still under way.
          submitToken.current += 1;
          setResolving(false);
          setQuery(next.slice(0, MENU_MAX_QUERY));
        }}
        onKeyDown={onInputKeyDown}
        maxLength={MENU_MAX_QUERY}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        enterKeyHint="search"
        aria-busy={resolving || loading || undefined}
      />
      <CommandList className="max-h-[min(60vh,420px)]">
        {nothing ? (
          // Not CommandEmpty: "Show all results" is always an item, so cmdk never counts zero.
          <p role="status" className="py-6 text-center text-sm">
            {NO_MATCH}
          </p>
        ) : null}
        {q && (loading || resolving) ? (
          <div
            role="status"
            className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"
          >
            <Spinner />
            {resolving ? `Looking up ${displayScannedValue(q)}…` : 'Searching…'}
          </div>
        ) : null}
        {failures.map((failure) => (
          <p key={failure.message} role="alert" className="px-4 py-2 text-sm text-destructive-text">
            {failure.message}
          </p>
        ))}

        {units && units.items.length > 0 ? (
          <CommandGroup heading="Storage units">
            {units.items
              .slice(0, MENU_PREVIEW)
              .map(unitRow)
              .map((row) => (
                <CommandItem key={row.key} value={`unit:${row.key}`} onSelect={() => go(row.href)}>
                  <span className="font-mono font-medium whitespace-nowrap">{row.id}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {[row.projectNumber, row.contents, row.where].filter(Boolean).join(' · ')}
                  </span>
                  <StageTag stage={row.stage.stage}>{row.stage.label}</StageTag>
                </CommandItem>
              ))}
          </CommandGroup>
        ) : null}
        {projects.length > 0 ? (
          <CommandGroup heading="Projects">
            {projects.map(projectRow).map((row) => (
              <CommandItem key={row.key} value={`project:${row.key}`} onSelect={() => go(row.href)}>
                <span className="font-mono font-medium whitespace-nowrap">{row.id}</span>
                <span className="min-w-0 flex-1 truncate">{row.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {concrete.length > 0 ? (
          <CommandGroup heading="Concrete sets">
            {concrete.slice(0, MENU_PREVIEW).map((row) => (
              <CommandItem
                key={row.key}
                value={`concrete:${row.key}`}
                onSelect={() => go(row.href)}
              >
                <span className="font-mono font-medium whitespace-nowrap">{row.id}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.title}</span>
                {row.tag ? <StageTag stage={row.tag.stage}>{row.tag.label}</StageTag> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {q ? (
          <CommandGroup heading="Results">
            <CommandItem value="show-all" onSelect={() => go(resultsPath(q))}>
              <LayoutList />
              <span>
                Show all results for <span className="font-mono">“{q}”</span>
              </span>
            </CommandItem>
          </CommandGroup>
        ) : null}

        {shownActions.length > 0 ? (
          <>
            {q ? <CommandSeparator /> : null}
            <CommandGroup heading="Actions">
              {shownActions.map((item) => (
                <LinkItem key={item.key} item={item} onSelect={() => go(item.to)} />
              ))}
            </CommandGroup>
          </>
        ) : null}
        {shownPages.length > 0 ? (
          <CommandGroup heading="Go to">
            {shownPages.map((item) => (
              <LinkItem key={item.key} item={item} onSelect={() => go(item.to)} />
            ))}
          </CommandGroup>
        ) : null}
        {shownHelp.length > 0 ? (
          <CommandGroup heading="Help">
            {shownHelp.map((item) => (
              <LinkItem
                key={item.key}
                item={item}
                shortcut={item.key === 'shortcuts' ? '?' : undefined}
                onSelect={() => (item.key === 'shortcuts' ? setView('shortcuts') : go(item.to))}
              />
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
      {redirected ? (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          Scan labels lives here now: scan a label, or type an ID.
        </p>
      ) : null}
    </CommandPrimitive>
  );
}

function LinkItem({
  item,
  onSelect,
  shortcut,
}: {
  item: MenuLink;
  onSelect: () => void;
  shortcut?: string;
}) {
  const Icon = item.icon ?? Search;
  return (
    <CommandItem value={`link:${item.key}`} onSelect={onSelect}>
      <Icon />
      <span>{item.label}</span>
      {shortcut ? <CommandShortcut>{shortcut}</CommandShortcut> : null}
    </CommandItem>
  );
}

/** The keyboard shortcuts (DESIGN.md › UX changes 7), inside the same dialog. */
function ShortcutsView({ onBack }: { onBack: () => void }) {
  const rows: [string, string][] = [
    [commandShortcutLabel(), 'Open or close search'],
    ['/', 'Open search'],
    ['?', 'Keyboard shortcuts'],
    ['Esc', 'Close'],
  ];
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          autoFocus
          aria-label="Back to search"
        >
          <ArrowLeft />
        </Button>
        <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        {rows.map(([keys, what]) => (
          <div key={what} className="contents">
            <dt>
              <Kbd>{keys}</Kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted-foreground">
        Scan a label with no field selected and it opens that storage unit or shelf. / and ? do
        nothing while you are typing in a field.
      </p>
    </div>
  );
}
