// Generates apps/web/src/strata-theme.css from design/strata-ui/src (index.css + Kyle's stage scales).
// The canvas switches dark with a .dark class; the app uses data-theme on <html> plus the OS setting
// (theme/theme.ts), so each dark block is emitted twice: under the OS media query (unless light was
// chosen) and for an explicit dark choice. Usage: node gen-strata-theme.cjs <worktree>
const fs = require('fs')
const W = process.argv[2]
const S = W + '/design/strata-ui/src/'
const src = fs.readFileSync(S + 'index.css', 'utf8').replace(/\r\n/g, '\n')
const block = (sel) => {
  const i = src.indexOf(sel + ' {\n')
  if (i < 0) throw new Error('missing ' + sel)
  const j = src.indexOf('\n}\n', i)
  return src.slice(i + sel.length + 3, j + 1)
}
const light = block(':root')
const dark = block('.dark')
const themeInline = block('@theme inline')
const MEDIA = "@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light'])"
const EXPLICIT = ":root[data-theme='dark']"
const indent = (s) => s.replace(/^(?=.)/gm, '  ')

const stageLight = fs.readFileSync(S + 'radix-stage-light.css', 'utf8').replace(/\r\n/g, '\n')
  .replace(/:root, \.light, \.light-theme \{/g, ':root {')
const stageDarkSrc = fs.readFileSync(S + 'radix-stage-dark.css', 'utf8').replace(/\r\n/g, '\n')
const stageDarkMedia = stageDarkSrc.replace(/\.dark, \.dark-theme \{/g, ":root:not([data-theme='light']) {")
const stageDarkExplicit = stageDarkSrc.replace(/\.dark, \.dark-theme \{/g, EXPLICIT + ' {')

const out = `/* Strata theme (DESIGN.md): shadcn variables filled from the Radix custom palette (accent #21206D),
   Kyle's stage scales, and the Tailwind theme mapping. GENERATED from design/strata-ui/src by
   design/strata-ui/gen-app-theme.cjs; edit the source there and regenerate.
   Dark follows the operating system until someone picks a theme; the choice is data-theme on
   <html> (theme/theme.ts, index.html). Keep the two dark blocks identical (theme-css.test.ts). */

/* Stage colour scales, light */
${stageLight}
/* Stage colour scales, dark (OS setting) */
@media (prefers-color-scheme: dark) {
${indent(stageDarkMedia)}}

/* Stage colour scales, dark (chosen) */
${stageDarkExplicit}
:root {
${light}  color-scheme: light;
}

${MEDIA} {
${indent(dark)}    color-scheme: dark;
  }
}

${EXPLICIT} {
${dark}  color-scheme: dark;
}

@custom-variant dark {
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) & {
      @slot;
    }
  }
  :root[data-theme='dark'] & {
    @slot;
  }
}

@theme inline {
${themeInline}}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground font-sans;
  }
}
`
fs.writeFileSync(W + '/apps/web/src/strata-theme.css', out)
console.log('ok', out.length)
