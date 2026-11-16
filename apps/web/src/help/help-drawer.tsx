import { ArrowLeft, ChevronRight, Keyboard } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { PeekToolbar, usePeekAvailable, usePeekKeys } from '@/components/strata/peek';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Kbd } from '@/components/ui/kbd';
import { useOptionalFeedbackDialog } from '../feedback/feedback-context';
import {
  SHORTCUTS_ANCHOR,
  groupAnchor,
  groupById,
  pageHelp,
  shortcutCount,
  visibleGroups,
  type HelpGuide,
  type HelpGroupId,
} from './guides';
import {
  CommonQuestions,
  GroupIcon,
  GuideAccordion,
  HelpSearchField,
  HelpSearchResults,
  ShortcutsList,
} from './help-content';
import {
  HelpDrawerContext,
  type HelpDrawerController,
  type HelpView,
  type OpenHelpOptions,
} from './help-drawer-context';
import './help-drawer.css';

// Help drawer (STRATA-103, round 10): `?` or account menu › Help opens it on the right of the
// current page, which stays where it is. Inbox's drawer sizes (46 % of the content, 30–65 %),
// PeekToolbar's Close (Esc) and Open as full page, and a "?" hint. Under 1024 px (no drawer, as
// for every peek) Help opens the /help page instead.

export const HELP_DRAWER_DEFAULT = 46;
export const HELP_DRAWER_MIN = 30;
export const HELP_DRAWER_MAX = 65;
const RESIZE_STEP = 2;

interface DrawerState {
  open: boolean;
  view: HelpView;
  /** Bumped when the drawer should take focus (an opening, or a hand-over from another layer). */
  focusToken: number;
  setView: (view: HelpView) => void;
  close: () => void;
}

const DrawerStateContext = createContext<DrawerState | null>(null);

/** The /help anchor for what the drawer shows, for Open as full page and narrow screens. */
function fullPageHref(view: HelpView, pathname: string): string {
  if (view.kind === 'shortcuts') return `/help#${SHORTCUTS_ANCHOR}`;
  if (view.kind === 'group') return `/help#${groupAnchor(view.id as HelpGroupId)}`;
  const first = pageHelp(pathname).guides[0];
  return first ? `/help#${first.id}` : '/help';
}

/**
 * Owns the drawer's open state. Rendered by the shell (AppLayout) around the command menu, so
 * `?` and the menu's Help items can open it; HelpDrawerSlot draws it beside the page.
 */
export function HelpDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<HelpView>({ kind: 'home' });
  const [focusToken, setFocusToken] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const available = usePeekAvailable();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pathRef = useRef(pathname);
  useLayoutEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  const openDrawer = useCallback(
    (options?: OpenHelpOptions) => {
      const next = options?.view ?? { kind: 'home' };
      if (!available) {
        void navigate(fullPageHref(next, pathRef.current));
        return;
      }
      const active = document.activeElement;
      returnFocus.current =
        options?.returnFocus ??
        (active instanceof HTMLElement && active !== document.body ? active : null);
      setView(next);
      setOpen(true);
      if (!options?.deferFocus) setFocusToken((token) => token + 1);
    },
    [available, navigate],
  );
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(
    (options?: OpenHelpOptions) => (open ? close() : openDrawer(options)),
    [open, close, openDrawer],
  );
  const focusDrawer = useCallback(() => setFocusToken((token) => token + 1), []);

  // The /help page is the same guides: the drawer closes when it opens.
  const [seenPath, setSeenPath] = useState(pathname);
  if (pathname !== seenPath) {
    setSeenPath(pathname);
    if (pathname === '/help' && open) setOpen(false);
  }

  // Closing gives focus back to the opener, unless the person has already moved on.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const target = returnFocus.current?.isConnected
      ? returnFocus.current
      : document.getElementById('main');
    returnFocus.current = null;
    target?.focus();
  }, [open]);

  const controller = useMemo<HelpDrawerController>(
    () => ({ isOpen: open, open: openDrawer, close, toggle, focusDrawer }),
    [open, openDrawer, close, toggle, focusDrawer],
  );
  const state = useMemo<DrawerState>(
    () => ({ open, view, focusToken, setView, close }),
    [open, view, focusToken, close],
  );

  return (
    <HelpDrawerContext.Provider value={controller}>
      <DrawerStateContext.Provider value={state}>{children}</DrawerStateContext.Provider>
    </HelpDrawerContext.Provider>
  );
}

/**
 * The drawer itself, placed by the shell right after `main` inside the sidebar inset. While it
 * is open the inset becomes two columns (help-drawer.css); the page keeps its element and state.
 */
export function HelpDrawerSlot() {
  const state = useContext(DrawerStateContext);
  const available = usePeekAvailable();
  usePeekKeys({ enabled: !!state?.open && available, onClose: state?.close });
  if (!state?.open || !available) return null;
  return <HelpDrawer state={state} />;
}

function clamp(size: number): number {
  return Math.min(HELP_DRAWER_MAX, Math.max(HELP_DRAWER_MIN, Math.round(size)));
}

function HelpDrawer({ state }: { state: DrawerState }) {
  const { view, setView, close, focusToken } = state;
  const { pathname } = useLocation();
  const [size, setSize] = useState(HELP_DRAWER_DEFAULT);
  const asideRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();

  // The two-column inset reads the drawer's share from its parent (help-drawer.css).
  useLayoutEffect(() => {
    const parent = asideRef.current?.parentElement;
    parent?.style.setProperty('--help-drawer-size', `${size}%`);
  }, [size]);
  useLayoutEffect(() => {
    const parent = asideRef.current?.parentElement;
    return () => {
      parent?.style.removeProperty('--help-drawer-size');
    };
  }, []);

  useEffect(() => {
    if (focusToken > 0) headingRef.current?.focus({ preventScroll: true });
  }, [focusToken]);

  // A new view puts focus on its heading, so keyboard users start at the top of it.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, [view]);

  function onResizeKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = {
      ArrowLeft: RESIZE_STEP,
      ArrowRight: -RESIZE_STEP,
      Home: HELP_DRAWER_MAX - size,
      End: HELP_DRAWER_MIN - size,
    };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    setSize((current) => clamp(current + step));
  }

  function onResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    const parent = asideRef.current?.parentElement;
    if (!parent || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      if (rect.width > 0) setSize(clamp(((rect.right - moveEvent.clientX) / rect.width) * 100));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  return (
    <aside
      ref={asideRef}
      aria-label="Help"
      data-slot="help-drawer"
      className="flex min-w-0 flex-col border-l bg-background"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the help drawer"
        aria-valuemin={HELP_DRAWER_MIN}
        aria-valuemax={HELP_DRAWER_MAX}
        aria-valuenow={size}
        tabIndex={0}
        data-slot="help-drawer-handle"
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 hover:after:bg-ring focus-visible:after:w-0.5 focus-visible:after:bg-ring"
        onKeyDown={onResizeKey}
        onPointerDown={onResizeStart}
      />
      <PeekToolbar onClose={close} fullPageHref={fullPageHref(view, pathname)}>
        <span className="mr-auto flex items-center gap-1.5 pl-1 text-[13px] text-muted-foreground">
          Open or close <Kbd>?</Kbd>
        </span>
      </PeekToolbar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 px-6 py-5">
          {view.kind === 'home' ? (
            <HomeView headingRef={headingRef} titleId={titleId} onView={setView} />
          ) : view.kind === 'shortcuts' ? (
            <SubView
              headingRef={headingRef}
              titleId={titleId}
              title="Keyboard shortcuts"
              onBack={() => setView({ kind: 'home' })}
            >
              <ShortcutsList idPrefix={`${titleId}-keys`} />
            </SubView>
          ) : (
            <GroupView
              headingRef={headingRef}
              titleId={titleId}
              groupId={view.id}
              onBack={() => setView({ kind: 'home' })}
            />
          )}
          <DrawerFoot />
        </div>
      </div>
    </aside>
  );
}

type HeadingRef = React.RefObject<HTMLHeadingElement | null>;

function DrawerHeading({
  headingRef,
  titleId,
  children,
}: {
  headingRef: HeadingRef;
  titleId: string;
  children: ReactNode;
}) {
  return (
    <h2 ref={headingRef} id={titleId} tabIndex={-1} className="text-xl font-semibold outline-none">
      {children}
    </h2>
  );
}

function HomeView({
  headingRef,
  titleId,
  onView,
}: {
  headingRef: HeadingRef;
  titleId: string;
  onView: (view: HelpView) => void;
}) {
  const { pathname } = useLocation();
  const help = pageHelp(pathname);
  const groups = visibleGroups();
  const [query, setQuery] = useState('');
  const feedback = useOptionalFeedbackDialog();
  const state = useContext(DrawerStateContext);
  const searching = query.trim().length > 0;
  const ids = { page: useId(), all: useId(), faq: useId(), results: useId() };

  return (
    <>
      <div className="flex flex-col gap-3">
        <DrawerHeading headingRef={headingRef} titleId={titleId}>
          {searching ? 'Search help' : help.heading}
        </DrawerHeading>
        <HelpSearchField value={query} onChange={setQuery} onEscapeEmpty={state?.close} />
      </div>
      {searching ? (
        <HelpSearchResults
          query={query}
          headingId={ids.results}
          onOpenGuide={(guide: HelpGuide) =>
            onView({ kind: 'group', id: `${guide.group}#${guide.id}` })
          }
          onAsk={feedback ? () => feedback.open({ choice: 'question' }) : undefined}
        />
      ) : (
        <>
          <section aria-labelledby={ids.page} className="flex flex-col gap-2">
            <h3 id={ids.page} className="text-[13px] font-medium text-muted-foreground">
              On this page
            </h3>
            {/* Keyed by page, so the first task opens again on another page. */}
            <GuideAccordion
              key={pathname}
              guides={help.guides}
              defaultValue={help.guides[0] ? [help.guides[0].id] : []}
            />
          </section>
          <section aria-labelledby={ids.all} className="flex flex-col gap-2">
            <h3 id={ids.all} className="text-[13px] font-medium text-muted-foreground">
              All guides
            </h3>
            <ItemGroup className="divide-y rounded-xl border bg-card">
              {groups.map(({ group, guides }) => (
                <GuideRow
                  key={group.id}
                  icon={<GroupIcon group={group} />}
                  label={group.label}
                  count={guides.length}
                  onOpen={() => onView({ kind: 'group', id: group.id })}
                />
              ))}
              <GuideRow
                icon={<Keyboard aria-hidden="true" />}
                label="Keyboard shortcuts"
                count={shortcutCount()}
                onOpen={() => onView({ kind: 'shortcuts' })}
              />
            </ItemGroup>
          </section>
          <CommonQuestions headingId={ids.faq} />
        </>
      )}
    </>
  );
}

function GuideRow({
  icon,
  label,
  count,
  onOpen,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  onOpen: () => void;
}) {
  return (
    <div role="listitem">
      <Item size="sm" asChild>
        <button
          type="button"
          className="w-full text-left hover:bg-accent/50"
          aria-label={`${label}, ${count}`}
          onClick={onOpen}
        >
          <ItemMedia variant="icon">{icon}</ItemMedia>
          <ItemContent>
            <ItemTitle>{label}</ItemTitle>
          </ItemContent>
          <ItemActions>
            <span className="font-mono text-[13px] text-muted-foreground">{count}</span>
            <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
          </ItemActions>
        </button>
      </Item>
    </div>
  );
}

function SubView({
  headingRef,
  titleId,
  title,
  onBack,
  children,
}: {
  headingRef: HeadingRef;
  titleId: string;
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-col gap-3">
        <Button variant="link" size="sm" className="h-auto self-start p-0" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          All help
        </Button>
        <DrawerHeading headingRef={headingRef} titleId={titleId}>
          {title}
        </DrawerHeading>
      </div>
      {children}
    </>
  );
}

/** One group's guides; `id` may name a guide to open (`<group>#<guide>`, from search). */
function GroupView({
  headingRef,
  titleId,
  groupId,
  onBack,
}: {
  headingRef: HeadingRef;
  titleId: string;
  groupId: string;
  onBack: () => void;
}) {
  const [id, guideId] = groupId.split('#');
  const entry = visibleGroups().find(({ group }) => group.id === id);
  const group = groupById(id ?? '');
  if (!entry || !group) {
    return (
      <SubView headingRef={headingRef} titleId={titleId} title="Help" onBack={onBack}>
        <p className="text-sm text-muted-foreground">This guide isn’t available.</p>
      </SubView>
    );
  }
  return (
    <SubView headingRef={headingRef} titleId={titleId} title={group.label} onBack={onBack}>
      <GuideAccordion key={groupId} guides={entry.guides} defaultValue={guideId ? [guideId] : []} />
    </SubView>
  );
}

function DrawerFoot() {
  const feedback = useOptionalFeedbackDialog();
  return (
    <div className="flex flex-col gap-1 border-t pt-4 text-[13px] text-muted-foreground">
      {feedback ? (
        <p>
          Still stuck?{' '}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-[13px] text-link"
            onClick={() => feedback.open({ choice: 'question' })}
          >
            Send feedback or a question
          </Button>
        </p>
      ) : null}
      <p>Help works on the office network only, like the rest of Material Mule.</p>
    </div>
  );
}
