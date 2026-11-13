import type { SidebarSectionId } from '@materialmule/shared';
import { ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Lock, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { SidebarSeparator } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { FIXED_PAGES, SECTION_INFO } from './nav';
import { moveSection, resetLayout, toggleIn, type SidebarPrefs } from './sidebar-prefs';

// Customize sidebar (DESIGN.md › Sidebar; STRATA-39): a mode of the sidebar itself, like
// Notion's. Today, Projects and Inbox are locked at the top; the sections below can be reordered
// and hidden. Changes apply at once and are saved for the person.
//
// Reordering: focus a grip, press Space, move with the arrow keys, Space to drop, Escape to
// cancel; every step is announced. The up/down buttons do the same for a mouse. Pointer dragging
// (dnd kit) waits on the @dnd-kit packages being installed; the keyboard model here matches it.

const ICON_BUTTON =
  'size-8 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring';

export function SidebarCustomize({
  sections,
  prefs,
  hasInbox,
  onDone,
}: {
  /** The sections this person can have, in their order (hidden ones included). */
  sections: SidebarSectionId[];
  prefs: SidebarPrefs;
  hasInbox: boolean;
  /** Leaves the mode; the caller puts focus back on "Customize sidebar". */
  onDone: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const grips = useRef(new Map<SidebarSectionId, HTMLButtonElement>());
  const [picked, setPicked] = useState<{ id: SidebarSectionId; order: SidebarSectionId[] } | null>(
    null,
  );
  const [message, setMessage] = useState('');
  const instructionsId = useId();
  const label = (id: SidebarSectionId) => SECTION_INFO[id].label;

  // Entering the mode focuses the first grip.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-customize-grip]')?.focus();
  }, []);

  // A moved row keeps focus on its grip.
  useEffect(() => {
    if (picked) grips.current.get(picked.id)?.focus();
  }, [picked, sections]);

  const placeOf = (id: SidebarSectionId, order: SidebarSectionId[]) =>
    `place ${order.indexOf(id) + 1} of ${order.length}`;

  const move = (id: SidebarSectionId, delta: -1 | 1, announce: boolean) => {
    const next = moveSection(prefs.layout, id, delta, sections);
    if (next === prefs.layout) return;
    // A function of the current layout, so a save that meets a newer saved layout reapplies it.
    prefs.update((layout) => moveSection(layout, id, delta, sections));
    if (announce) {
      const order = next.order.filter((item) => sections.includes(item));
      setMessage(`${label(id)} is now at ${placeOf(id, order)}.`);
    }
  };

  const onGripKey = (id: SidebarSectionId) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (picked?.id === id) {
        setPicked(null);
        setMessage(`Dropped ${label(id)} at ${placeOf(id, sections)}.`);
      } else {
        setPicked({ id, order: prefs.layout.order });
        setMessage(`Picked up ${label(id)}.`);
      }
      return;
    }
    if (picked?.id !== id) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(id, event.key === 'ArrowUp' ? -1 : 1, true);
    } else if (event.key === 'Escape') {
      // Escape cancels the move first; the next Escape leaves the mode.
      event.preventDefault();
      event.stopPropagation();
      const before = picked.order;
      prefs.update((layout) => ({ ...layout, order: before }));
      setPicked(null);
      setMessage(`Moving ${label(id)} was cancelled.`);
    }
  };

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label="Customize sidebar"
      className="flex min-h-0 flex-1 flex-col gap-2 p-2"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onDone();
        }
      }}
    >
      <div className="px-2 pt-1">
        <h2 className="text-sm font-semibold">Customize sidebar</h2>
        <p className="text-[13px] text-muted-foreground">
          Move sections up or down. The eye shows or hides one.
        </p>
      </div>
      <div>
        <h3 className="flex h-8 items-center px-2 text-[13px] font-medium text-sidebar-foreground/70">
          Always at the top
        </h3>
        <ul aria-label="Fixed pages" className="flex flex-col">
          {FIXED_PAGES.filter((page) => hasInbox || page.label !== 'Inbox').map((page) => (
            <li
              key={page.label}
              className="flex h-9 items-center gap-1 pr-0.5 text-muted-foreground"
            >
              <span className="flex h-9 w-7 shrink-0 items-center justify-center">
                <Lock aria-hidden="true" className="size-3.5" />
                <span className="sr-only">Locked:</span>
              </span>
              <page.icon aria-hidden="true" className="mx-1 size-4 shrink-0" />
              <span className="text-sm">{page.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <SidebarSeparator className="mx-2" />
      <div>
        <h3 className="flex h-8 items-center px-2 text-[13px] font-medium text-sidebar-foreground/70">
          Sections
        </h3>
        <p id={instructionsId} className="sr-only">
          To move a section, press Space. Use the up and down arrow keys to move it, Space to drop
          it, or Escape to cancel.
        </p>
        <ul aria-label="Sidebar sections" className="flex flex-col">
          {sections.map((id, index) => {
            const info = SECTION_INFO[id];
            const shown = !prefs.layout.hidden.includes(id);
            const isPicked = picked?.id === id;
            return (
              <li
                key={id}
                className={cn(
                  'group/row flex h-9 items-center gap-0.5 rounded-md bg-sidebar pr-0.5 pointer-coarse:h-11',
                  isPicked && 'relative z-10 shadow-md ring-1 ring-sidebar-border',
                )}
              >
                <Button
                  ref={(node) => {
                    if (node) grips.current.set(id, node);
                    else grips.current.delete(id);
                  }}
                  type="button"
                  variant="ghost"
                  data-customize-grip=""
                  aria-label={`Move ${info.label}`}
                  aria-pressed={isPicked}
                  aria-describedby={instructionsId}
                  onKeyDown={onGripKey(id)}
                  onBlur={(event) => {
                    // Moving to another control drops the section where it is. A blur from the
                    // row being moved in the list (no next target) keeps it picked up.
                    if (isPicked && event.relatedTarget) setPicked(null);
                  }}
                  className="h-9 w-7 cursor-grab text-muted-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                >
                  <GripVertical aria-hidden="true" />
                </Button>
                <info.icon
                  aria-hidden="true"
                  className={cn('mx-1 size-4 shrink-0', !shown && 'text-muted-foreground')}
                />
                <span
                  className={cn(
                    'flex-1 truncate text-sm',
                    !shown && 'text-muted-foreground line-through decoration-1',
                  )}
                >
                  {info.label}
                  {shown ? null : <span className="sr-only"> (hidden)</span>}
                </span>
                <span className="flex opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${info.label} up`}
                    disabled={index === 0}
                    onClick={() => move(id, -1, true)}
                    className={ICON_BUTTON}
                  >
                    <ChevronUp aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${info.label} down`}
                    disabled={index === sections.length - 1}
                    onClick={() => move(id, 1, true)}
                    className={ICON_BUTTON}
                  >
                    <ChevronDown aria-hidden="true" />
                  </Button>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={shown}
                  aria-label={`Show ${info.label} in the sidebar`}
                  onClick={() =>
                    prefs.update((layout) => ({
                      ...layout,
                      hidden: toggleIn(layout.hidden, id, shown),
                    }))
                  }
                  className={ICON_BUTTON}
                >
                  {shown ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                </Button>
              </li>
            );
          })}
        </ul>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            prefs.update(resetLayout);
            setMessage('The sidebar is back to its default order, with every section shown.');
          }}
          className="mt-1 h-9 w-full justify-start gap-2 px-2 font-normal text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring pointer-coarse:h-11"
        >
          <RotateCcw aria-hidden="true" />
          Reset to default
        </Button>
      </div>
      <p aria-live="assertive" className="sr-only">
        {message}
      </p>
      <Button
        asChild
        variant="link"
        className="mt-auto h-auto justify-start px-2 text-[13px] text-muted-foreground"
      >
        <Link to="/help#sidebar">How the sidebar works</Link>
      </Button>
      <Button type="button" className="w-full pointer-coarse:h-11" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
