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
