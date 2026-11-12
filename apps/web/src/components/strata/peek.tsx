// List plus peek (STRATA-24/73, STRATA-122, STRATA-64; DESIGN.md › Detail sheet, Inbox).
//
// One reusable layout for every list that opens a record beside it on desktop:
// - `usePeekParam` keeps the open record in the URL (`?open=<id>`), so Back closes the drawer and
//   a reload restores it. Other query params (filters, sort, page) are never touched.
// - `PeekSplit` is the list and the drawer as resizable panels (default 44 %, 30–65 %; drag or
//   arrow keys on the handle). The list sits in a named container (`@container/list`) so its
//   columns hide by the list's own width, open or not.
// - `PeekToolbar` is the drawer's toolbar. Every control is optional: Help has no Previous/Next,
//   report review brings its own navigation.
// - `usePeekKeys` gives Esc / K / J.
// - `usePeekAvailable` says whether the drawer exists at all: phones and tablets (under 1024 px)
//   always open the full page.
//
// Focus return: rows that open a peek carry `data-peek-id="<id>"` (the DataTable row sets it) and
// are focusable. When the drawer closes, PeekSplit focuses the row of the record that was last
// open; if that row is gone (filtered out, next page), the element that opened the drawer; if that
// is gone too, the list container.

import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronDown, ChevronUp, SquareArrowOutUpRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useMediaQuery } from '../useMediaQuery';

/** The drawer exists from 1024 px up; narrower screens open the full page instead. */
export const PEEK_MEDIA_QUERY = '(min-width: 1024px)';

/** Whether a row should open the drawer (true) or navigate to the full page (false). */
// eslint-disable-next-line react-refresh/only-export-components -- peek mechanics belong with PeekSplit
export function usePeekAvailable(): boolean {
  return useMediaQuery(PEEK_MEDIA_QUERY);
}

export interface PeekParam {
  /** The open record's ID, or null when the drawer is closed. */
  openId: string | null;
  /**
   * Open a record. The first open pushes a history entry (so Back closes the drawer); moving
   * between records while open replaces it (so Back doesn't walk through every record viewed).
   * Pass `replace` to override.
   */
  open: (id: string, opts?: { replace?: boolean }) => void;
  /** Close the drawer: removes the param (replacing the entry), keeps every other param. */
  close: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components -- peek mechanics belong with PeekSplit
export function usePeekParam(param = 'open'): PeekParam {
  const [params, setParams] = useSearchParams();
  const openId = params.get(param) || null;

  const open = useCallback(
    (id: string, opts?: { replace?: boolean }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(param, id);
          return next;
        },
        { replace: opts?.replace ?? openId !== null },
      );
    },
    [param, openId, setParams],
  );

  const close = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(param);
        return next;
      },
      { replace: true },
    );
  }, [param, setParams]);

  return { openId, open, close };
}

export interface PeekNeighbours {
  /** 0-based position of the open record in `ids`, or -1 when it isn't in the current results. */
  index: number;
  total: number;
  previousId: string | null;
  nextId: string | null;
}

/** Previous/next in the host's current result order (no wrap-around at either end). */
// eslint-disable-next-line react-refresh/only-export-components -- peek mechanics belong with PeekSplit
export function peekNeighbours(ids: readonly string[], openId: string | null): PeekNeighbours {
  const total = ids.length;
  const index = openId === null ? -1 : ids.indexOf(openId);
  if (index === -1) return { index, total, previousId: null, nextId: null };
  return {
    index,
    total,
    previousId: index > 0 ? ids[index - 1]! : null,
    nextId: index < total - 1 ? ids[index + 1]! : null,
  };
}

const BLOCKING_LAYERS =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"], [role="listbox"]';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
    ? true
    : false;
}

/**
 * Esc closes, K previous, J next. Ignored while typing (input, textarea, select, contenteditable),
 * with Ctrl/Meta/Alt held, or while a dialog, menu or listbox is open (they own those keys).
 */
// eslint-disable-next-line react-refresh/only-export-components -- peek mechanics belong with PeekSplit
export function usePeekKeys({
  enabled,
  onClose,
  onPrevious,
  onNext,
}: {
  enabled: boolean;
  onClose?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}): void {
  const handlers = useRef({ onClose, onPrevious, onNext });
  useLayoutEffect(() => {
    handlers.current = { onClose, onPrevious, onNext };
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target)) return;
      if (document.querySelector(BLOCKING_LAYERS)) return;
      const { onClose: close, onPrevious: previous, onNext: next } = handlers.current;
      let handler: (() => void) | undefined;
      if (event.key === 'Escape') handler = close;
      else if (event.key === 'k' || event.key === 'K') handler = previous;
      else if (event.key === 'j' || event.key === 'J') handler = next;
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

/**
 * Returns focus when the drawer closes: to `[data-peek-id="<last open id>"]` inside the list, else
 * to the element that opened the drawer, else to the list container. Only moves focus when it was
 * lost (on the body) or still inside the closing drawer, never away from something the person
 * chose meanwhile. PeekSplit calls this for you when given `openId`.
 */
// eslint-disable-next-line react-refresh/only-export-components -- peek mechanics belong with PeekSplit
export function usePeekFocusReturn(
  openId: string | null,
  listRef: React.RefObject<HTMLElement | null>,
  drawerRef?: React.RefObject<HTMLElement | null>,
): void {
  const lastOpenId = useRef<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  // Before paint, so the opener is whatever had focus when the drawer opened.
  useLayoutEffect(() => {
    if (openId !== null && lastOpenId.current === null) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
  }, [openId]);

  useEffect(() => {
    const closedId = lastOpenId.current;
    lastOpenId.current = openId;
    if (openId !== null || closedId === null) return;

    const active = document.activeElement;
    const drawer = drawerRef?.current;
    const focusLost =
      !active ||
      active === document.body ||
      !active.isConnected ||
      (drawer ? drawer.contains(active) : false);
    if (!focusLost) return;

    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-peek-id="${cssEscape(closedId)}"]`);
    const target = row ?? (opener.current?.isConnected ? opener.current : null) ?? list;
    opener.current = null;
    target?.focus();
  }, [openId, listRef, drawerRef]);
}

export interface PeekSplitProps {
  /** The list (table, stream). Rendered inside the `@container/list` wrapper, open or not. */
  list: ReactNode;
  /** The drawer contents, usually a PeekToolbar and the record. Ignored while closed. */
  drawer?: ReactNode;
  open: boolean;
  /** The open record's ID; enables focus return to its `[data-peek-id]` row on close. */
  openId?: string | null;
  defaultSize?: string;
  minSize?: string;
  maxSize?: string;
  /** Names the drawer region: the ID of the drawer's title (preferred)… */
  drawerLabelledBy?: string;
  /** …or a plain label when there is no visible title. */
  drawerLabel?: string;
  /** Accessible name of the list container (the focus fallback). */
  listLabel?: string;
  className?: string;
}

/**
 * The list and, when open, the record drawer beside it. The list panel is always the same element,
 * so opening and closing the drawer never remounts the list (scroll and selection survive).
 */
export function PeekSplit({
  list,
  drawer,
  open,
  openId,
  defaultSize = '44%',
  minSize = '30%',
  maxSize = '65%',
  drawerLabelledBy,
  drawerLabel,
  listLabel,
  className,
}: PeekSplitProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  usePeekFocusReturn(openId === undefined ? null : open ? openId : null, listRef, drawerRef);

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className={cn('min-h-0', className)}
      data-slot="peek-split"
      data-state={open ? 'open' : 'closed'}
    >
      <ResizablePanel id="peek-list" minSize="35%" className="min-w-0">
        <div
          ref={listRef}
          tabIndex={-1}
          aria-label={listLabel}
          data-slot="peek-list"
          className="@container/list h-full min-w-0 overflow-auto outline-none"
        >
          {list}
        </div>
      </ResizablePanel>
      {open && (
        <>
          <ResizableHandle withHandle aria-label="Resize the drawer" />
          <ResizablePanel
            id="peek-drawer"
            defaultSize={defaultSize}
            minSize={minSize}
            maxSize={maxSize}
            className="min-w-0"
          >
            <div
              ref={drawerRef}
              role="region"
              aria-labelledby={drawerLabelledBy}
              aria-label={drawerLabelledBy ? undefined : (drawerLabel ?? 'Record')}
              data-slot="peek-drawer"
              className="flex h-full min-w-0 flex-col overflow-auto bg-background"
            >
              {drawer}
            </div>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

export interface PeekToolbarProps {
  onClose: () => void;
  /** Link to the record's full page ("Open as full page"). */
  fullPageHref?: string;
  /** Position in the host's results; `index` is 0-based and shown as "index + 1 of total". */
  position?: { index: number; total: number };
  /** Previous record (K). Pass undefined at the first record to disable the button. */
  onPrevious?: () => void;
  /** Next record (J). Pass undefined at the last record to disable the button. */
  onNext?: () => void;
  /**
   * Whether to show Previous/Next at all (default: when either handler or `position` is given).
   * Set false to hide them while still showing the position.
   */
  showNavigation?: boolean;
  /** Extra controls (page-specific actions) placed before Open as full page and Close. */
  children?: ReactNode;
  className?: string;
}

function ToolbarIconButton({
  label,
  shortcut,
  tooltip,
  onClick,
  disabled,
  children,
}: {
  label: string;
  shortcut?: string;
  tooltip: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-keyshortcuts={shortcut}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** The drawer's toolbar. Renders only the controls it is given. */
export function PeekToolbar({
  onClose,
  fullPageHref,
  position,
  onPrevious,
  onNext,
  showNavigation,
  children,
  className,
}: PeekToolbarProps) {
  const navigation =
    showNavigation ?? (onPrevious !== undefined || onNext !== undefined || position !== undefined);
  const showPosition = position !== undefined && position.index >= 0 && position.total > 0;

  return (
    <TooltipProvider>
      <div
        data-slot="peek-toolbar"
        className={cn('flex h-12 shrink-0 items-center gap-1 border-b px-2', className)}
      >
        {navigation && (
          <>
            <ToolbarIconButton
              label="Previous"
              shortcut="K"
              tooltip="Previous (K)"
              onClick={onPrevious}
              disabled={!onPrevious}
            >
              <ChevronUp aria-hidden="true" />
            </ToolbarIconButton>
            <ToolbarIconButton
              label="Next"
              shortcut="J"
              tooltip="Next (J)"
              onClick={onNext}
              disabled={!onNext}
            >
              <ChevronDown aria-hidden="true" />
            </ToolbarIconButton>
          </>
        )}
        {showPosition && (
          <span className="px-1 text-sm text-muted-foreground tabular-nums">
            {position.index + 1} of {position.total}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {children}
          {fullPageHref && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" asChild>
                  <Link to={fullPageHref} aria-label="Open as full page">
                    <SquareArrowOutUpRight aria-hidden="true" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open as full page</TooltipContent>
            </Tooltip>
          )}
          <ToolbarIconButton
            label="Close"
            shortcut="Escape"
            tooltip="Close (Esc)"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </ToolbarIconButton>
        </div>
      </div>
    </TooltipProvider>
  );
}
