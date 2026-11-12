// The Strata UI bundle for the Design canvas: real shadcn/ui components and Lucide icons, exposed
// as window.Strata so artboards mount them with <x-import component-from-global-scope="Strata.X">.
import "./index.css"
import * as React from "react"
import * as Lucide from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers"
import { CSS } from "@dnd-kit/utilities"
import * as Accordion from "@/components/ui/accordion"
import * as Alert from "@/components/ui/alert"
import * as AlertDialog from "@/components/ui/alert-dialog"
import * as Avatar from "@/components/ui/avatar"
import * as Badge from "@/components/ui/badge"
import * as Breadcrumb from "@/components/ui/breadcrumb"
import * as Button from "@/components/ui/button"
import * as ButtonGroup from "@/components/ui/button-group"
import * as Calendar from "@/components/ui/calendar"
import * as Card from "@/components/ui/card"
import * as Checkbox from "@/components/ui/checkbox"
import * as Collapsible from "@/components/ui/collapsible"
import * as Command from "@/components/ui/command"
import * as Dialog from "@/components/ui/dialog"
import * as Dropdown from "@/components/ui/dropdown-menu"
import * as Empty from "@/components/ui/empty"
import * as Field from "@/components/ui/field"
import * as HoverCard from "@/components/ui/hover-card"
import * as Input from "@/components/ui/input"
import * as InputGroup from "@/components/ui/input-group"
import * as Item from "@/components/ui/item"
import * as Kbd from "@/components/ui/kbd"
import * as Label from "@/components/ui/label"
import * as Pagination from "@/components/ui/pagination"
import * as Popover from "@/components/ui/popover"
import * as Progress from "@/components/ui/progress"
import * as RadioGroup from "@/components/ui/radio-group"
import * as Resizable from "@/components/ui/resizable"
import * as ScrollArea from "@/components/ui/scroll-area"
import * as Select from "@/components/ui/select"
import * as Separator from "@/components/ui/separator"
import * as Sheet from "@/components/ui/sheet"
import * as Sidebar from "@/components/ui/sidebar"
import * as Skeleton from "@/components/ui/skeleton"
import * as Sonner from "@/components/ui/sonner"
import * as Spinner from "@/components/ui/spinner"
import * as Switch from "@/components/ui/switch"
import * as Table from "@/components/ui/table"
import * as Tabs from "@/components/ui/tabs"
import * as Textarea from "@/components/ui/textarea"
import * as Toggle from "@/components/ui/toggle"
import * as ToggleGroup from "@/components/ui/toggle-group"
import * as Tooltip from "@/components/ui/tooltip"

/**
 * A Lucide icon by its lucide.dev name, e.g. <Icon name="flask-conical" />. 16 px unless a size-*
 * class says otherwise: the canvas wraps mounted components in a display:contents div, so shadcn's
 * "[&>svg]:size-4" rules don't reach icons placed in markup, and Lucide's own default is 24 px.
 */
function Icon({ name, className, ...props }: { name: string } & Lucide.LucideProps) {
  const key = name.replace(/(^|-)(\w)/g, (_m: string, _d: string, c: string) => c.toUpperCase())
  const icons = Lucide as unknown as Record<string, React.ComponentType<Lucide.LucideProps>>
  const Component = icons[key]
  if (!Component) return React.createElement("span", { title: "Unknown Lucide icon: " + name }, "?")
  return React.createElement(Component, {
    "aria-hidden": true,
    className: cn("size-4 shrink-0", className),
    ...props,
  })
}

/**
 * The root every board wraps itself in: sets the theme on the page root (so Radix portals such as
 * menus, dialogs and tooltips follow it) and provides the TooltipProvider shadcn's Tooltip needs.
 */
function Theme({ dark, children }: { dark?: boolean; children?: React.ReactNode }) {
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", !!dark)
  }, [dark])
  return React.createElement(Tooltip.TooltipProvider, { delayDuration: 200 }, children)
}

/**
 * shadcn/ui (current) takes `ref` as an ordinary prop, which only React 19 supports. The canvas runs
 * React 18, where function components drop refs, so Radix menus and tooltips lose their anchors.
 * Wrapping each component in forwardRef hands the ref back in as a prop, as React 19 would.
 */
function withRefs<T extends Record<string, unknown>>(mod: T): T {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === "function" && /^[A-Z]/.test(name)) {
      const Inner = value as (props: Record<string, unknown>) => React.ReactNode
      const Wrapped = React.forwardRef<unknown, Record<string, unknown>>((props, ref) =>
        Inner(ref ? { ...props, ref } : props) as React.ReactElement,
      )
      Wrapped.displayName = name
      out[name] = Wrapped
    } else {
      out[name] = value
    }
  }
  return out as T
}

const modules = [
  Accordion, Alert, AlertDialog, Avatar, Badge, Breadcrumb, Button, ButtonGroup, Calendar, Card,
  Checkbox, Collapsible, Command, Dialog, Dropdown, Empty, Field, HoverCard, Input, InputGroup, Item,
  Kbd, Label, Pagination, Popover, Progress, RadioGroup, Resizable, ScrollArea, Select, Separator, Sheet,
  Sidebar, Skeleton, Sonner, Spinner, Switch, Table, Tabs, Textarea, Toggle, ToggleGroup, Tooltip,
] as Record<string, unknown>[]

const Strata: Record<string, unknown> = { Icon, Theme, toast }
for (const mod of modules) {
  for (const [name, value] of Object.entries(withRefs(mod))) {
    if (name in Strata && Strata[name] !== value) console.warn("Strata: duplicate export " + name)
    Strata[name] = value
  }
}

// Strata composites. Built from the ref-safe components above, because the canvas can't nest
// asChild triggers in markup (each x-import gets its own wrapper element).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const S = Strata as Record<string, any>

/**
 * A sidebar parent with sub-pages (Retention, Concrete). Expanded sidebar: a row that unfolds its
 * sub-pages in place. Collapsed (icon) sidebar: a 44 px icon with a tooltip that opens the
 * sub-pages in a menu to the right, so every page stays reachable. `items` is "A|B|C".
 */
function NavCollapsible({ icon, label, items, defaultOpen, isActive }: {
  icon: string; label: string; items?: string; defaultOpen?: boolean; isActive?: boolean
}) {
  const { state, isMobile } = Sidebar.useSidebar()
  const list = (items || "").split("|").filter(Boolean)
  if (state === "collapsed" && !isMobile) {
    return (
      <S.SidebarMenuItem>
        <S.DropdownMenu>
          <S.Tooltip>
            <S.TooltipTrigger asChild>
              <S.DropdownMenuTrigger asChild>
                <S.SidebarMenuButton isActive={isActive}>
                  <Icon name={icon} />
                  <span>{label}</span>
                </S.SidebarMenuButton>
              </S.DropdownMenuTrigger>
            </S.TooltipTrigger>
            <S.TooltipContent side="right" align="center">{label}</S.TooltipContent>
          </S.Tooltip>
          <S.DropdownMenuContent side="right" align="start" sideOffset={8} className="w-52">
            <S.DropdownMenuLabel>{label}</S.DropdownMenuLabel>
            {list.map((item) => (
              <S.DropdownMenuItem key={item}>{item}</S.DropdownMenuItem>
            ))}
          </S.DropdownMenuContent>
        </S.DropdownMenu>
      </S.SidebarMenuItem>
    )
  }
  return (
    <S.Collapsible defaultOpen={defaultOpen} asChild className="group/collapsible">
      <S.SidebarMenuItem>
        <S.CollapsibleTrigger asChild>
          <S.SidebarMenuButton isActive={isActive}>
            <Icon name={icon} />
            <span>{label}</span>
            <Icon
              name="chevron-right"
              className="ml-auto transition-transform duration-200 ease-out group-data-[state=open]/collapsible:rotate-90 motion-reduce:transition-none"
            />
          </S.SidebarMenuButton>
        </S.CollapsibleTrigger>
        <S.CollapsibleContent>
          <S.SidebarMenuSub>
            {list.map((item) => (
              <S.SidebarMenuSubItem key={item}>
                <S.SidebarMenuSubButton href="#">
                  <span>{item}</span>
                </S.SidebarMenuSubButton>
              </S.SidebarMenuSubItem>
            ))}
          </S.SidebarMenuSub>
        </S.CollapsibleContent>
      </S.SidebarMenuItem>
    </S.Collapsible>
  )
}

/** Collapsed sidebar only: one 44 px icon with a tooltip that opens `children` as a menu. */
function NavFlyout({ icon, label, children }: { icon: string; label: string; children?: React.ReactNode }) {
  const { state, isMobile } = Sidebar.useSidebar()
  if (state !== "collapsed" || isMobile) return null
  return (
    <S.SidebarMenuItem>
      <S.DropdownMenu>
        <S.Tooltip>
          <S.TooltipTrigger asChild>
            <S.DropdownMenuTrigger asChild>
              <S.SidebarMenuButton>
                <Icon name={icon} />
                <span>{label}</span>
              </S.SidebarMenuButton>
            </S.DropdownMenuTrigger>
          </S.TooltipTrigger>
          <S.TooltipContent side="right" align="center">{label}</S.TooltipContent>
        </S.Tooltip>
        <S.DropdownMenuContent side="right" align="start" sideOffset={8} className="w-64">
          <S.DropdownMenuLabel>{label}</S.DropdownMenuLabel>
          {children}
        </S.DropdownMenuContent>
      </S.DropdownMenu>
    </S.SidebarMenuItem>
  )
}

/**
 * The sidebar's "Search or scan" field and the Ctrl K command menu (shadcn CommandDialog). Clicking
 * the field and pressing Ctrl K open the same menu with the cursor in its input; a scanned label
 * types into that input like any other text, so scanning while it is open finds the record.
 * Fictional data only.
 */
function NavSearch() {
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const close = () => setOpen(false)
  const item = (icon: string, label: React.ReactNode, extra?: React.ReactNode, value?: string) => (
    <S.CommandItem key={value || String(label)} value={value || String(label)} onSelect={close}>
      <Icon name={icon} />
      {label}
      {extra}
    </S.CommandItem>
  )
  const unit = (id: string, where: string) =>
    item(
      "package",
      <span className="font-mono text-[13px]">{id}</span>,
      <span className="text-muted-foreground truncate">{where}</span>,
      id + " " + where,
    )
  return (
    <>
      <S.SidebarMenuItem>
        <S.SidebarMenuButton
          variant="outline"
          tooltip="Search or scan a label (Ctrl K)"
          aria-keyshortcuts="Control+K"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="text-muted-foreground rounded-full px-4 group-data-[collapsible=icon]:rounded-md"
        >
          <Icon name="scan-search" />
          <span>Search or scan</span>
          <S.Kbd className="ml-auto text-[13px] group-data-[collapsible=icon]:hidden">Ctrl K</S.Kbd>
        </S.SidebarMenuButton>
      </S.SidebarMenuItem>
      <S.CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search or scan"
        description="Find a storage unit, project or page, or scan a label."
      >
        <S.CommandInput placeholder="Search or scan a label…" />
        <S.CommandList>
          <S.CommandEmpty>Nothing matches. Check the ID, or scan the label again.</S.CommandEmpty>
          <S.CommandGroup heading="Storage units">
            {unit("BKT-2026-000019", "DEMO-2601 · TH26-01 · Shelf A3")}
            {unit("ST-2026-000004", "DEMO-2601 · TH26-02 · Tube rack 2")}
            {unit("CRE-2026-000002", "DEMO-2612 · TH26-01 · Core shelf")}
          </S.CommandGroup>
          <S.CommandGroup heading="Projects">
            {item("folder", <span className="font-mono text-[13px]">DEMO-2601</span>, <span className="text-muted-foreground">Riverbank</span>, "DEMO-2601 Riverbank")}
            {item("folder", <span className="font-mono text-[13px]">DEMO-2616</span>, <span className="text-muted-foreground">Riverside apts</span>, "DEMO-2616 Riverside apts")}
          </S.CommandGroup>
          <S.CommandSeparator />
          <S.CommandGroup heading="Actions">
            {item("arrow-down-to-line", "Receive storage units")}
            {item("arrow-right-left", "Move storage units")}
            {item("printer", "Print labels")}
            {item("folder-plus", "New project")}
          </S.CommandGroup>
          <S.CommandGroup heading="Go to">
            {item("house", "Today")}
            {item("package", "Inventory")}
            {item("flask-conical", "Lab programs")}
            {item("hammer", "Breaks")}
            {item("settings", "Settings")}
          </S.CommandGroup>
        </S.CommandList>
      </S.CommandDialog>
    </>
  )
}

/**
 * A list and a resizable peek drawer on the right, like Notion's side peek. The first child is the
 * list, the second the drawer. Built here because react-resizable-panels finds its panels as
 * direct children, which the canvas's wrapper elements would hide. Drag the divider, or focus it
 * and use the arrow keys.
 */
function PeekSplit({ children, peekSize = "44%", minPeek = "30%", maxPeek = "65%" }: {
  children?: React.ReactNode; peekSize?: string; minPeek?: string; maxPeek?: string
}) {
  const parts = React.Children.toArray(children).filter((c) => typeof c !== "string" || c.trim() !== "")
  return (
    <S.ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <S.ResizablePanel id="peek-list" minSize="35%">
        <div className="h-full overflow-y-auto">{parts[0]}</div>
      </S.ResizablePanel>
      <S.ResizableHandle withHandle aria-label="Resize the drawer" />
      <S.ResizablePanel id="peek-drawer" defaultSize={peekSize} minSize={minPeek} maxSize={maxPeek}>
        {parts[1]}
      </S.ResizablePanel>
    </S.ResizablePanelGroup>
  )
}

/*
 * Sidebar layout: section order, hidden sections and which sections are folded. The app saves
 * this per person on the server; the canvas keeps it in this browser's localStorage so a board
 * comes back as it was left. Recent starts folded, everything else open.
 */
type SidebarLayout = { order: string[]; hidden: string[]; open: Record<string, boolean> }
const SECTION_INFO: Record<string, { label: string; icon: string }> = {
  pinned: { label: "Pinned", icon: "pin" },
  recent: { label: "Recent", icon: "history" },
  storage: { label: "Storage units", icon: "package" },
  soils: { label: "Soils", icon: "flask-conical" },
  concrete: { label: "Concrete", icon: "cylinder" },
}
const LAYOUT_KEY = "strata.sidebar-layout.v1"
const defaultLayout = (): SidebarLayout => ({
  order: ["pinned", "recent", "storage", "soils", "concrete"],
  hidden: [],
  open: { pinned: true, recent: false, storage: true, soils: true, concrete: true },
})
function readLayout(): SidebarLayout {
  try {
    const saved = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || "null")
    if (saved && Array.isArray(saved.order)) {
      const d = defaultLayout()
      const order = saved.order.filter((id: string) => id in SECTION_INFO)
      for (const id of d.order) if (!order.includes(id)) order.push(id)
      return { order, hidden: Array.isArray(saved.hidden) ? saved.hidden : [], open: { ...d.open, ...saved.open } }
    }
  } catch {
    /* storage blocked: use the default */
  }
  return defaultLayout()
}
let layout: SidebarLayout | null = null
const layoutListeners = new Set<() => void>()
function getLayout(): SidebarLayout {
  if (!layout) layout = readLayout()
  return layout
}
function setLayout(next: SidebarLayout) {
  layout = next
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
  } catch {
    /* not saved */
  }
  layoutListeners.forEach((fn) => fn())
}
function useSidebarLayout() {
  return React.useSyncExternalStore((fn) => {
    layoutListeners.add(fn)
    return () => {
      layoutListeners.delete(fn)
    }
  }, getLayout)
}

/**
 * A sidebar section whose heading folds it, like Notion's. The fold is saved, so the section is
 * as the person left it. Its place and visibility come from Customize sidebar. Collapsed (icon)
 * sidebar: work sections show their icons; with `flyout` (Pinned, Recent) the section is one icon
 * that opens its second child (DropdownMenuItems) as a menu.
 */
function NavSection({ id, label, flyout, children }: {
  id: string; label?: string; flyout?: boolean; children?: React.ReactNode
}) {
  const { state, isMobile } = Sidebar.useSidebar()
  const l = useSidebarLayout()
  const info = SECTION_INFO[id] || { label: label || id, icon: "folder" }
  const name = label || info.label
  if (l.hidden.includes(id)) return null
  const parts = React.Children.toArray(children).filter((c) => typeof c !== "string" || c.trim() !== "")
  const style = { order: l.order.indexOf(id) + 1 }
  if (state === "collapsed" && !isMobile) {
    return (
      <S.SidebarGroup style={style}>
        {flyout ? (
          <S.SidebarMenu>
            <NavFlyout icon={info.icon} label={name}>{parts[1]}</NavFlyout>
          </S.SidebarMenu>
        ) : (
          parts[0]
        )}
      </S.SidebarGroup>
    )
  }
  const open = l.open[id] !== false
  const setOpen = (o: boolean) => setLayout({ ...getLayout(), open: { ...getLayout().open, [id]: o } })
  return (
    <S.Collapsible open={open} onOpenChange={setOpen} asChild className="group/section">
      <S.SidebarGroup style={style}>
        <S.SidebarGroupLabel asChild>
          <S.CollapsibleTrigger className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground w-full gap-1 text-left">
            <span>{name}</span>
            <Icon
              name="chevron-right"
              aria-hidden="true"
              className="size-3.5! opacity-0 transition-[transform,opacity] duration-150 ease-out group-hover/section:opacity-100 group-focus-within/section:opacity-100 group-data-[state=closed]/section:opacity-100 group-data-[state=open]/section:rotate-90 motion-reduce:transition-none"
            />
          </S.CollapsibleTrigger>
        </S.SidebarGroupLabel>
        <S.CollapsibleContent>{parts[0]}</S.CollapsibleContent>
      </S.SidebarGroup>
    </S.Collapsible>
  )
}

function SortableSection({ id }: { id: string }) {
  const l = useSidebarLayout()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id })
  const info = SECTION_INFO[id]
  const shown = !l.hidden.includes(id)
  const toggle = () =>
    setLayout({
      ...getLayout(),
      hidden: shown ? [...getLayout().hidden, id] : getLayout().hidden.filter((h) => h !== id),
    })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "bg-sidebar flex h-9 items-center gap-1 rounded-md pr-0.5",
        isDragging && "ring-sidebar-border relative z-10 shadow-md ring-1",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={"Move " + info.label}
        data-customize-grip=""
        className="text-muted-foreground hover:bg-sidebar-accent ring-sidebar-ring flex h-9 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md outline-hidden focus-visible:ring-2 active:cursor-grabbing"
      >
        <Icon name="grip-vertical" />
      </button>
      <Icon name={info.icon} className={cn("mx-1 shrink-0", !shown && "text-muted-foreground")} />
      <span className={cn("flex-1 truncate text-sm", !shown && "text-muted-foreground line-through decoration-1")}>{info.label}</span>
      <button
        type="button"
        aria-pressed={shown}
        aria-label={"Show " + info.label + " in the sidebar"}
        onClick={toggle}
        className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ring-sidebar-ring flex size-8 shrink-0 items-center justify-center rounded-md outline-hidden focus-visible:ring-2"
      >
        <Icon name={shown ? "eye" : "eye-off"} />
      </button>
    </li>
  )
}

type DndId = { id: string | number }
const sectionLabel = (a: DndId) => SECTION_INFO[String(a.id)]?.label || String(a.id)

/*
 * Customize mode, like Notion's: "Customize sidebar" turns the sidebar itself into an editor. The
 * page list is swapped for the fixed pages and the sections with grips and eye toggles; Done (or
 * Escape) puts the sidebar back. The page root gets data-sidebar-editing="true" so markup can hide
 * the normal list with `in-data-[sidebar-editing=true]:hidden`.
 */
let editing = false
const editingListeners = new Set<() => void>()
function setEditing(on: boolean) {
  editing = on
  try {
    if (on) document.documentElement.setAttribute("data-sidebar-editing", "true")
    else document.documentElement.removeAttribute("data-sidebar-editing")
  } catch {
    /* no document */
  }
  editingListeners.forEach((fn) => fn())
}
function useEditing() {
  return React.useSyncExternalStore((fn) => {
    editingListeners.add(fn)
    return () => {
      editingListeners.delete(fn)
    }
  }, () => editing)
}

const FIXED_PAGES = [
  { label: "Today", icon: "house" },
  { label: "Projects", icon: "folder" },
  { label: "Inbox", icon: "inbox" },
]

/**
 * The "Customize sidebar" row at the bottom of the sidebar, and the customize mode it opens in the
 * sidebar itself. Drag a grip (or focus it, press Space and use the arrow keys) to reorder
 * sections; the eye shows or hides one. Changes apply at once and are saved for the person.
 */
function SidebarCustomize({ defaultOpen }: { defaultOpen?: boolean }) {
  const on = useEditing()
  const l = useSidebarLayout()
  const { setOpen: setSidebarOpen, state } = Sidebar.useSidebar()
  const panelRef = React.useRef<HTMLDivElement>(null)
  const rowRef = React.useRef<HTMLButtonElement>(null)
  const wasOn = React.useRef(false)
  React.useLayoutEffect(() => {
    if (defaultOpen) setEditing(true)
    return () => setEditing(false)
  }, [defaultOpen])
  React.useEffect(() => {
    if (on) {
      panelRef.current?.querySelector<HTMLElement>("[data-customize-grip]")?.focus()
    } else if (wasOn.current) {
      rowRef.current?.focus()
    }
    wasOn.current = on
  }, [on])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const order = getLayout().order
    setLayout({
      ...getLayout(),
      order: arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id))),
    })
  }
  const announcements = {
    onDragStart: ({ active }: { active: DndId }) => "Picked up " + sectionLabel(active) + ".",
    onDragOver: ({ active, over }: { active: DndId; over: DndId | null }) =>
      over
        ? sectionLabel(active) + " is now at place " + (getLayout().order.indexOf(String(over.id)) + 1) + " of " + getLayout().order.length + "."
        : "",
    onDragEnd: ({ active }: { active: DndId }) => "Dropped " + sectionLabel(active) + ".",
    onDragCancel: ({ active }: { active: DndId }) => "Moving " + sectionLabel(active) + " was cancelled.",
  }

  if (!on) {
    return (
      <S.SidebarMenu>
        <S.SidebarMenuItem>
          <S.SidebarMenuButton
            ref={rowRef}
            tooltip="Customize sidebar"
            onClick={() => {
              if (state === "collapsed") setSidebarOpen(true)
              setEditing(true)
            }}
            className="text-muted-foreground"
          >
            <Icon name="sliders-horizontal" />
            <span>Customize sidebar</span>
          </S.SidebarMenuButton>
        </S.SidebarMenuItem>
      </S.SidebarMenu>
    )
  }

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label="Customize sidebar"
      className="flex min-h-0 flex-1 flex-col gap-2"
      onKeyDown={(e) => {
        // Escape leaves customize mode, except while a section is picked up (dnd kit cancels that drag).
        if (e.key === "Escape" && !panelRef.current?.querySelector("[data-customize-grip][aria-pressed='true']")) setEditing(false)
      }}
    >
      <div className="px-2 pt-1">
        <p className="text-sm font-semibold">Customize sidebar</p>
        <p className="text-muted-foreground text-[13px]">Drag to reorder. The eye shows or hides a section.</p>
      </div>
      <div>
        <p className="text-sidebar-foreground/70 flex h-8 items-center px-2 text-[13px] font-medium">Always at the top</p>
        <ul aria-label="Fixed pages" className="flex flex-col">
          {FIXED_PAGES.map((p) => (
            <li key={p.label} className="text-muted-foreground flex h-9 items-center gap-1 pr-0.5">
              <span aria-hidden="true" className="flex h-9 w-7 shrink-0 items-center justify-center">
                <Icon name="lock" className="size-3.5" />
              </span>
              <Icon name={p.icon} className="mx-1 shrink-0" />
              <span className="text-sm">{p.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <S.SidebarSeparator className="mx-2" />
      <div>
        <p className="text-sidebar-foreground/70 flex h-8 items-center px-2 text-[13px] font-medium">Sections</p>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={onDragEnd}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable: "To move a section, press Space. Use the up and down arrow keys to move it, Space to drop it, or Escape to cancel.",
            },
          }}
        >
          <SortableContext items={l.order} strategy={verticalListSortingStrategy}>
            <ul aria-label="Sidebar sections" className="flex flex-col">
              {l.order.map((id) => (
                <SortableSection key={id} id={id} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        <button
          type="button"
          onClick={() => setLayout(defaultLayout())}
          className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ring-sidebar-ring mt-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm outline-hidden focus-visible:ring-2"
        >
          <Icon name="rotate-ccw" />
          Reset to default
        </button>
      </div>
      <S.Button className="mt-auto w-full" onClick={() => setEditing(false)}>
        Done
      </S.Button>
    </div>
  )
}

/**
 * The toolbar every table and list page carries at its top right, like Notion's: Search, Filter,
 * Sort and View, as 36 px icon buttons with tooltips. Search comes first; clicking it opens a
 * search box in its place that pushes the other icons to the right (CSS width transition, no
 * motion library). Escape, or leaving the box empty, closes it. A filter that is on tints the
 * Filter icon and shows a dot. Lists are "A|B|C"; `view` is the current view's label.
 */
function TableToolbar({
  placeholder = "Search…",
  filters = "",
  sorts = "Newest first|Oldest first",
  views = "",
  view = "",
  searchOpen = false,
  columns = "",
  children,
}: {
  placeholder?: string; filters?: string; sorts?: string; views?: string; view?: string; searchOpen?: boolean; columns?: string; children?: React.ReactNode
}) {
  const split = (v: string) => v.split("|").filter(Boolean)
  const [open, setOpen] = React.useState(!!searchOpen)
  const [query, setQuery] = React.useState("")
  const [on, setOn] = React.useState<string[]>([])
  const [sort, setSort] = React.useState(split(sorts)[0] || "")
  const [current, setCurrent] = React.useState(view || split(views)[0] || "")
  const inputRef = React.useRef<HTMLInputElement>(null)
  const searchBtnRef = React.useRef<HTMLButtonElement>(null)
  const opened = React.useRef(false)
  React.useEffect(() => {
    if (open && opened.current) inputRef.current?.focus()
    opened.current = true
  }, [open])
  const close = () => {
    setOpen(false)
    setQuery("")
    requestAnimationFrame(() => searchBtnRef.current?.focus())
  }
  const iconButton =
    "text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent focus-visible:ring-ring/50 relative flex size-9 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-[3px]"
  const tip = (label: string, child: React.ReactElement) => (
    <S.Tooltip>
      <S.TooltipTrigger asChild>{child}</S.TooltipTrigger>
      <S.TooltipContent side="bottom">{label}</S.TooltipContent>
    </S.Tooltip>
  )
  const filterOn = on.length > 0
  const cols = split(columns).map((c) => ({ label: c.replace(/!$/, ""), fixed: c.endsWith("!") }))
  const slug = (label: string) => label.toLowerCase().replace(/\s+/g, "-")
  const [hiddenCols, setHiddenCols] = React.useState<string[]>([])
  const toggleCol = (label: string, show: boolean) => {
    const next = show ? hiddenCols.filter((h) => h !== label) : [...hiddenCols, label]
    setHiddenCols(next)
    document.querySelectorAll("table").forEach((t) => t.toggleAttribute("data-hide-" + slug(label), !show))
  }
  return (
    // TableToolbar children first: page actions such as Mark all read, then a divider.
    <S.TooltipProvider delayDuration={300}>
    <div role="toolbar" aria-label="Table tools" className="flex items-center gap-0.5">
      {children ? (
        <>
          {children}
          <S.Separator orientation="vertical" className="mx-1 h-5! self-center" />
        </>
      ) : null}
      {split(filters).length ? (
        <S.DropdownMenu>
          {tip(
            filterOn ? "Filter, " + on.length + " on" : "Filter",
            <S.DropdownMenuTrigger aria-label={filterOn ? "Filter, " + on.length + " on" : "Filter"} className={cn(iconButton, filterOn && "text-primary")}>
              <Icon name="list-filter" />
              {filterOn ? <span aria-hidden="true" className="bg-primary absolute top-1.5 right-1.5 size-1.5 rounded-full" /> : null}
            </S.DropdownMenuTrigger>,
          )}
          <S.DropdownMenuContent align="end" className="w-52">
            <S.DropdownMenuLabel>Filter</S.DropdownMenuLabel>
            {split(filters).map((f) => (
              <S.DropdownMenuCheckboxItem
                key={f}
                checked={on.includes(f)}
                onSelect={(e: Event) => e.preventDefault()}
                onCheckedChange={(c: boolean) => setOn((o) => (c ? [...o, f] : o.filter((x) => x !== f)))}
              >
                {f}
              </S.DropdownMenuCheckboxItem>
            ))}
            {filterOn ? (
              <>
                <S.DropdownMenuSeparator />
                <S.DropdownMenuItem onSelect={() => setOn([])}>
                  <Icon name="x" />
                  Clear filters
                </S.DropdownMenuItem>
              </>
            ) : null}
          </S.DropdownMenuContent>
        </S.DropdownMenu>
      ) : null}

      <S.DropdownMenu>
        {tip(
          "Sort",
          <S.DropdownMenuTrigger aria-label={"Sort, " + sort} className={iconButton}>
            <Icon name="arrow-up-down" />
          </S.DropdownMenuTrigger>,
        )}
        <S.DropdownMenuContent align="end" className="w-52">
          <S.DropdownMenuLabel>Sort</S.DropdownMenuLabel>
          <S.DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
            {split(sorts).map((s) => (
              <S.DropdownMenuRadioItem key={s} value={s}>{s}</S.DropdownMenuRadioItem>
            ))}
          </S.DropdownMenuRadioGroup>
        </S.DropdownMenuContent>
      </S.DropdownMenu>

      {split(views).length || cols.length ? (
        <S.DropdownMenu>
          {tip(
            "View",
            <S.DropdownMenuTrigger aria-label={"View, " + current} className={iconButton}>
              <Icon name="sliders-horizontal" />
            </S.DropdownMenuTrigger>,
          )}
          <S.DropdownMenuContent align="end" className="w-56">
            {split(views).length ? (
              <>
                <S.DropdownMenuLabel>View</S.DropdownMenuLabel>
                <S.DropdownMenuRadioGroup value={current} onValueChange={setCurrent}>
                  {split(views).map((v) => (
                    <S.DropdownMenuRadioItem key={v} value={v}>{v}</S.DropdownMenuRadioItem>
                  ))}
                </S.DropdownMenuRadioGroup>
              </>
            ) : null}
            {cols.length ? (
              <>
                {split(views).length ? <S.DropdownMenuSeparator /> : null}
                <S.DropdownMenuLabel>Columns</S.DropdownMenuLabel>
                {cols.map((c) => (
                  <S.DropdownMenuCheckboxItem
                    key={c.label}
                    checked={c.fixed || !hiddenCols.includes(c.label)}
                    disabled={c.fixed}
                    onSelect={(e: Event) => e.preventDefault()}
                    onCheckedChange={(v: boolean) => toggleCol(c.label, v)}
                  >
                    <span className="flex-1">{c.label}</span>
                    {c.fixed ? <span className="text-muted-foreground text-[12px]">Always shown</span> : null}
                  </S.DropdownMenuCheckboxItem>
                ))}
              </>
            ) : null}
          </S.DropdownMenuContent>
        </S.DropdownMenu>
      ) : null}

      {/* Search: the icon, or the open box in its place. */}
      <div
        className={cn(
          "flex h-9 items-center overflow-hidden rounded-md transition-[width,background-color,box-shadow] duration-200 ease-out motion-reduce:transition-none",
          open ? "border-input bg-background w-56 border shadow-xs" : "w-9",
        )}
      >
        {open ? (
          <>
            <Icon name="search" aria-hidden="true" className="text-muted-foreground ml-2.5 shrink-0" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault()
                  close()
                }
              }}
              onBlur={() => {
                if (!query) setOpen(false)
              }}
              placeholder={placeholder}
              aria-label={placeholder.replace(/…$/, "")}
              className="placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent px-2 text-sm outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery("")
                  inputRef.current?.focus()
                }}
                className="text-muted-foreground hover:text-foreground mr-1 flex size-7 shrink-0 items-center justify-center rounded-sm"
              >
                <Icon name="x" />
              </button>
            ) : null}
          </>
        ) : (
          tip(
            "Search",
            <button ref={searchBtnRef} type="button" aria-label="Search" aria-expanded={false} className={iconButton} onClick={() => setOpen(true)}>
              <Icon name="search" />
            </button>,
          )
        )}
      </div>

    </div>
    </S.TooltipProvider>
  )
}

/**
 * A sortable column heading for the compact table, like Notion's: the whole heading is a button
 * (icon, label, and an arrow showing the sort). Clicking cycles ascending, descending, then back to
 * the default order (newest first); one column sorts at a time, and the heading's `th` carries
 * `aria-sort`. `col` is the cell index in each row; `by="order"` sorts by the original order
 * (Received, which is already newest first). The canvas reorders the rendered rows itself; the app
 * sorts on the server and shares this state with the toolbar's Sort menu.
 */
function SortHeader({ label, icon, col, by, align }: {
  label: string; icon?: string; col: number | string; by?: string; align?: string
}) {
  const ref = React.useRef<HTMLButtonElement>(null)
  const [dir, setDir] = React.useState<"none" | "ascending" | "descending">("none")
  const index = Number(col)
  React.useEffect(() => {
    const table = ref.current?.closest("table")
    if (!table) return
    const onSort = (e: Event) => {
      const d = (e as CustomEvent).detail as { col: number; dir: "none" | "ascending" | "descending" }
      setDir(d.col === index ? d.dir : "none")
    }
    table.addEventListener("strata:sort", onSort)
    return () => table.removeEventListener("strata:sort", onSort)
  }, [index])
  React.useEffect(() => {
    ref.current?.closest("th")?.setAttribute("aria-sort", dir)
  }, [dir])
  const sort = () => {
    const table = ref.current?.closest("table")
    const body = table?.querySelector("tbody")
    if (!table || !body) return
    const next = dir === "none" ? "ascending" : dir === "ascending" ? "descending" : "none"
    const rows = Array.from(body.querySelectorAll("tr"))
    rows.forEach((tr, i) => {
      if (tr.dataset.order === undefined) tr.dataset.order = String(i)
    })
    const key = (tr: HTMLTableRowElement) => {
      if (next === "none") return Number(tr.dataset.order)
      // Original order is newest first, so ascending (oldest first) is its reverse.
      if (by === "order") return -Number(tr.dataset.order)
      return (tr.querySelectorAll("td")[index]?.textContent || "").replace("Unread.", "").trim().toLowerCase()
    }
    rows.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      const c = typeof ka === "number" ? ka - (kb as number) : String(ka).localeCompare(String(kb), undefined, { numeric: true })
      const tie = Number(a.dataset.order) - Number(b.dataset.order)
      return (next === "descending" ? -c : c) || tie
    })
    // Rows sit in the canvas's wrapper elements; move the wrapper that is tbody's child.
    rows.forEach((tr) => {
      let el: HTMLElement = tr
      while (el.parentElement && el.parentElement !== body) el = el.parentElement
      body.appendChild(el)
    })
    table.dispatchEvent(new CustomEvent("strata:sort", { detail: { col: index, dir: next } }))
  }
  const arrow = dir === "ascending" ? "arrow-up" : dir === "descending" ? "arrow-down" : "arrow-up-down"
  return (
    <button
      ref={ref}
      type="button"
      onClick={sort}
      className={cn(
        "group/sort hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 -mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-1.5 px-2 text-[13px] font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-inset",
        align === "right" && "justify-end",
        dir !== "none" && "text-foreground",
      )}
    >
      {icon ? <Icon name={icon} className="size-3.5 shrink-0" /> : null}
      <span className="truncate">{label}</span>
      <Icon
        name={arrow}
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 transition-opacity duration-100 motion-reduce:transition-none",
          dir === "none" ? "opacity-0 group-hover/sort:opacity-60 group-focus-visible/sort:opacity-60" : "text-primary opacity-100",
        )}
      />
    </button>
  )
}

Strata.SortHeader = SortHeader
Strata.TableToolbar = TableToolbar
Strata.NavSection = NavSection
Strata.SidebarCustomize = SidebarCustomize
Strata.PeekSplit = PeekSplit
Strata.NavCollapsible = NavCollapsible
Strata.NavFlyout = NavFlyout
Strata.NavSearch = NavSearch

;(window as unknown as { Strata: typeof Strata }).Strata = Strata

export default Strata
