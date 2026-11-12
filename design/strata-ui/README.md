# Strata UI bundle (design canvas only)

Real shadcn/ui components, themed with Strata (DESIGN.md), packaged so the Strata Design canvas
can mount them. It is design tooling, not part of the app: `apps/web` will add shadcn itself in
the redesign's wave 0. Not an npm workspace; excluded from ESLint and Prettier.

- shadcn 4.23 (new-york) components in `src/components/ui`, added with the shadcn CLI.
- Radix (`radix-ui` 1.8.1), Tailwind CSS 4.3, `lucide-react` 1.72, React 18.3 (not bundled).
- `src/index.css`: the Strata theme as shadcn variables (light and `.dark`), plus `stage-*`
  colours and the Atkinson Hyperlegible fonts. It also scans `../strata-canvas/project` so
  Tailwind classes written in artboard markup are compiled.
- `src/index.tsx`: exposes everything as `window.Strata` (`Strata.SidebarMenuButton`,
  `Strata.DropdownMenu`, …), plus `Strata.Icon` (any Lucide icon by its lucide.dev name) and
  `Strata.Theme` (sets the `dark` class on the page root so menus and tooltips follow it).

## Writing boards that mount these components

- Pass styling to a mounted component as `class-name="…"`, never `class="…"`. The canvas applies
  a `class` on `<x-import>` straight to the element and wipes out the component's own classes;
  `class-name` reaches the component as its `className` prop and merges with its styles.
- The canvas wraps each mounted component in a `display: contents` div. Layout is unaffected,
  but shadcn rules that look for a direct child (`[&>svg]:size-4`, `has-[>svg]:…`) don't match.
  `Strata.Icon` is 16 px by default for that reason. `Alert` with an icon needs
  `class-name="grid-cols-[calc(var(--spacing)*4)_1fr] gap-x-3"`.
- Triggers (`DropdownMenuTrigger`, `PopoverTrigger`, `DialogTrigger`, …) are used without
  `asChild`, styled with `class-name`, because a wrapped child can't be their anchor.
- The same wrapper makes every mounted component its wrapper's only child, so `first:` and
  `last:` rules match every item. A joined `ToggleGroup` then shows a rounded, double-bordered
  seam; give its items `class-name` overrides (first item
  `data-[spacing=0]:last:rounded-r-none`, the next
  `data-[spacing=0]:first:rounded-l-none data-[spacing=0]:data-[variant=outline]:first:border-l-0`).
- A `style` attribute may hold only one `{{…}}` hole; with two, the runtime drops the style.
- Wrap each board in `Strata.Theme` (dark mode, and the TooltipProvider that Tooltip needs).
- New Tailwind classes in a board only exist after a rebuild (`npm run build`).

## Previewing a board locally

The canvas's own runtime can render boards outside claude.ai. Read
`artifact-type/dc-runtime.js` from the canvas with the Artifact tool, copy the canvas's
`project/` folder (boards and `strata-ui/`) into a scratch folder, save the runtime there as
`support.js`, then serve it:

```bash
node design/strata-ui/serve.cjs <that folder> 4792
```

and open `http://127.0.0.1:4792/Main.dc.html`. This is how the components board was checked.

## Two fixes for the canvas

1. **React 18 refs.** Current shadcn passes `ref` as a normal prop, which only React 19 supports.
   The canvas runs React 18, so `withRefs` wraps every exported component in `forwardRef`.
   Without it, Radix menus and tooltips lose their anchor and open off-screen.
2. **Late React.** The canvas loads React after the page's scripts run. `wrap.cjs` (run by
   `npm run build`) makes the bundle wait for `window.React` and `window.ReactDOM` before it
   starts, and it is ready before the canvas renders.

## Build and publish

```bash
cd design/strata-ui
npm ci
npm run build
```

Copy `dist/strata-ui.js` and `dist/strata-ui.css` to the canvas as
`project/strata-ui/strata-ui.js` and `.css` and publish them. Artboards load them after the
`support.js` line:

```html
<link rel="stylesheet" href="strata-ui/strata-ui.css">
<script src="strata-ui/strata-ui.js"></script>
```

and mount components with
`<x-import component-from-global-scope="Strata.SidebarMenuButton" tooltip="Today">…</x-import>`.
Attributes become props (`is-active` → `isActive`); `class` becomes `className`.

`design/strata-canvas/project` is a copy of the canvas's boards (the canvas itself is the source
of truth: https://claude.ai/artifact/8yageikqVDfVbrptmtWqGi). Rebuild after adding Tailwind classes
to a board.

To test outside the canvas, copy React 18's UMD files
(`node_modules/react/umd/react.production.min.js`,
`node_modules/react-dom/umd/react-dom.production.min.js`) and the two `dist` files into `test/`
and serve that folder. `index.html` loads React first; `late.html` loads it after the bundle, as
the canvas does.
