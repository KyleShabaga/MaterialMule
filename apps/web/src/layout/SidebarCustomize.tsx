import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SidebarSectionId } from '@materialmule/shared';
import { ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Lock, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { SidebarSeparator } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { FIXED_PAGES, SECTION_INFO } from './nav';
import {
  moveSection,
  moveSectionTo,
  resetLayout,
  toggleIn,
  type SidebarPrefs,
} from './sidebar-prefs';

// Customize sidebar (DESIGN.md › Sidebar; STRATA-39): a mode of the sidebar itself, like
// Notion's. Today, Projects and Inbox are locked at the top; the sections below can be reordered
// and hidden. Changes apply at once and are saved for the person.
//
// Reordering is dnd kit sortable: drag a grip with the pointer (kept on the vertical axis, inside
// the list), or focus a grip, press Space, move with the arrow keys, Space to drop, Escape to
// cancel. Every step is announced. The up/down buttons move one place in a click. Escape cancels
// an active drag first; only with no drag does it leave the mode.

const ICON_BUTTON =
  'size-8 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring';

const MODIFIERS = [restrictToVerticalAxis, restrictToParentElement];

// dnd kit's own live region stays silent: this panel announces in its own words.
const SILENT = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragMove: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

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
  const [active, setActive] = useState<SidebarSectionId | null>(null);
  // Read by the panel's Escape handler, which runs before dnd kit's document listener cancels.
  const dragging = useRef(false);
  // The place last announced during a drag, so the first "over" (the row itself) stays quiet.
  const lastOver = useRef<SidebarSectionId | null>(null);
  const [message, setMessage] = useState('');
  const instructionsId = useId();
  const label = (id: SidebarSectionId) => SECTION_INFO[id].label;
  const placeOf = (index: number) => `place ${index + 1} of ${sections.length}`;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Entering the mode focuses the first grip.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-customize-grip]')?.focus();
  }, []);

  const move = (id: SidebarSectionId, delta: -1 | 1) => {
    const next = moveSection(prefs.layout, id, delta, sections);
    if (next === prefs.layout) return;
    // A function of the current layout, so a save that meets a newer saved layout reapplies it.
    prefs.update((layout) => moveSection(layout, id, delta, sections));
    const order = next.order.filter((item) => sections.includes(item));
    setMessage(`${label(id)} is now at ${placeOf(order.indexOf(id))}.`);
  };

  const endDrag = () => {
    dragging.current = false;
    setActive(null);
  };

  const onDragStart = ({ active: picked }: DragStartEvent) => {
    const id = picked.id as SidebarSectionId;
    dragging.current = true;
    lastOver.current = id;
    setActive(id);
    setMessage(`Picked up ${label(id)}.`);
  };

  const onDragOver = ({ active: picked, over }: DragOverEvent) => {
    if (!over || over.id === lastOver.current) return;
    lastOver.current = over.id as SidebarSectionId;
    const at = sections.indexOf(over.id as SidebarSectionId);
    setMessage(`${label(picked.id as SidebarSectionId)} is now at ${placeOf(at)}.`);
  };

  const onDragEnd = ({ active: picked, over }: DragEndEvent) => {
    endDrag();
    const id = picked.id as SidebarSectionId;
    const target = (over?.id ?? id) as SidebarSectionId;
    // A function of the current layout, as for the buttons.
    if (target !== id) prefs.update((layout) => moveSectionTo(layout, id, target, sections));
    setMessage(`Dropped ${label(id)} at ${placeOf(sections.indexOf(target))}.`);
  };

  const onDragCancel = () => {
    if (active) setMessage(`Moving ${label(active)} was cancelled.`);
    endDrag();
  };

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label="Customize sidebar"
      className="flex min-h-0 flex-1 flex-col gap-2 p-2"
      onKeyDown={(event) => {
        // Escape cancels a drag first (dnd kit handles it); the next Escape leaves the mode.
        if (event.key !== 'Escape' || event.defaultPrevented || dragging.current) return;
        event.preventDefault();
        onDone();
      }}
    >
      <div className="px-2 pt-1">
        <h2 className="text-sm font-semibold">Customize sidebar</h2>
        <p className="text-[13px] text-muted-foreground">
          Drag sections to reorder them. The eye shows or hides one.
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={MODIFIERS}
          accessibility={{ announcements: SILENT, screenReaderInstructions: { draggable: '' } }}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <SortableContext items={sections} strategy={verticalListSortingStrategy}>
            <ul aria-label="Sidebar sections" className="relative flex flex-col">
              {sections.map((id, index) => (
                <SectionRow
                  key={id}
                  id={id}
                  first={index === 0}
                  last={index === sections.length - 1}
                  shown={!prefs.layout.hidden.includes(id)}
                  instructionsId={instructionsId}
                  onMove={(delta) => move(id, delta)}
                  onToggle={(hide) =>
                    prefs.update((layout) => ({
                      ...layout,
                      hidden: toggleIn(layout.hidden, id, hide),
                    }))
                  }
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
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

function SectionRow({
  id,
  first,
  last,
  shown,
  instructionsId,
  onMove,
  onToggle,
}: {
  id: SidebarSectionId;
  first: boolean;
  last: boolean;
  shown: boolean;
  instructionsId: string;
  onMove: (delta: -1 | 1) => void;
  /** `hide`: true hides the section, false shows it again. */
  onToggle: (hide: boolean) => void;
}) {
  const info = SECTION_INFO[id];
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'group/row flex h-9 items-center gap-0.5 rounded-md bg-sidebar pr-0.5 pointer-coarse:h-11',
        isDragging && 'relative z-10 shadow-md ring-1 ring-sidebar-border',
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        data-customize-grip=""
        {...attributes}
        {...listeners}
        aria-label={`Move ${info.label}`}
        aria-pressed={isDragging}
        aria-describedby={instructionsId}
        className={cn(
          'h-9 w-7 touch-none text-muted-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring pointer-coarse:h-11 pointer-coarse:w-11',
          isDragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
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
          disabled={first}
          onClick={() => onMove(-1)}
          className={ICON_BUTTON}
        >
          <ChevronUp aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${info.label} down`}
          disabled={last}
          onClick={() => onMove(1)}
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
        onClick={() => onToggle(shown)}
        className={ICON_BUTTON}
      >
        {shown ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
      </Button>
    </li>
  );
}
