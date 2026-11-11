// The Strata UI bundle for the Design canvas: real shadcn/ui components and Lucide icons, exposed
// as window.Strata so artboards mount them with <x-import component-from-global-scope="Strata.X">.
import "./index.css"
import * as React from "react"
import * as Lucide from "lucide-react"
import * as Sidebar from "@/components/ui/sidebar"
import * as Dropdown from "@/components/ui/dropdown-menu"
import * as Avatar from "@/components/ui/avatar"
import * as Collapsible from "@/components/ui/collapsible"
import * as Badge from "@/components/ui/badge"
import * as Button from "@/components/ui/button"
import * as Kbd from "@/components/ui/kbd"
import * as Separator from "@/components/ui/separator"
import * as Tooltip from "@/components/ui/tooltip"

/** A Lucide icon by its lucide.dev name, e.g. <Icon name="flask-conical" />. */
function Icon({ name, ...props }: { name: string } & Lucide.LucideProps) {
  const key = name.replace(/(^|-)(\w)/g, (_m: string, _d: string, c: string) => c.toUpperCase())
  const icons = Lucide as unknown as Record<string, React.ComponentType<Lucide.LucideProps>>
  const Component = icons[key]
  if (!Component) return React.createElement("span", { title: "Unknown Lucide icon: " + name }, "?")
  return React.createElement(Component, { "aria-hidden": true, ...props })
}

/** Sets the theme on the page root, so Radix portals (menus, tooltips) follow it too. */
function Theme({ dark, children }: { dark?: boolean; children?: React.ReactNode }) {
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", !!dark)
  }, [dark])
  return React.createElement(React.Fragment, null, children)
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

const Strata = {
  ...withRefs(Sidebar),
  ...withRefs(Dropdown),
  ...withRefs(Avatar),
  ...withRefs(Collapsible),
  ...withRefs(Badge),
  ...withRefs(Button),
  ...withRefs(Kbd),
  ...withRefs(Separator),
  ...withRefs(Tooltip),
  Icon,
  Theme,
}

;(window as unknown as { Strata: typeof Strata }).Strata = Strata

export default Strata
