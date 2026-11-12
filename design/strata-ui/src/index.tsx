// The Strata UI bundle for the Design canvas: real shadcn/ui components and Lucide icons, exposed
// as window.Strata so artboards mount them with <x-import component-from-global-scope="Strata.X">.
import "./index.css"
import * as React from "react"
import * as Lucide from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
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
  Kbd, Label, Pagination, Popover, Progress, RadioGroup, ScrollArea, Select, Separator, Sheet,
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

Strata.NavCollapsible = NavCollapsible
Strata.NavFlyout = NavFlyout
Strata.NavSearch = NavSearch

;(window as unknown as { Strata: typeof Strata }).Strata = Strata

export default Strata
