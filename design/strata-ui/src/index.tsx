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

;(window as unknown as { Strata: typeof Strata }).Strata = Strata

export default Strata
