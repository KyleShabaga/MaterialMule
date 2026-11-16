---
target: all screens except the component boards (design/strata-canvas/project)
date: 2026-11-12
canvas_version: 71
total_score: 15
max_score: 20
p0: 0
p1: 1
p2: 3
p3: 3
---

# Strata audit: all screens except the component boards

Scope: 46 boards at 1280×800, light and dark (shell, settings, sign in ×11, Today ×20, Inbox ×12). Excluded: Main, MainDark, SidebarNav, SidebarVariants. Evidence: the Impeccable detector on every rendered board; an in-page probe on every board (text contrast against the real background, accessible names, target sizes, headings, landmarks, labels, duplicate IDs, reduced-motion rules); a source scan for hard-coded colours and costly effects.

## Audit Health Score

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 3 | Two sign-in states have no heading; 18 px switches and 16 px row checkboxes pass only by label/spacing exceptions |
| 2 | Performance | 3 | Width animations on layout properties (quick actions, table search); canvas-only DOM re-sorting |
| 3 | Theming | 4 | Tokens throughout, light and dark for every area; only logo and brand-mark hex values |
| 4 | Responsive Design | 2 | Every screen drawn only at 1280×800; 1024 px, tablet and 200 % zoom (640 px) undefined |
| 5 | Implementation Integrity | 3 | 18 detector hits, 13 false positives; real: nested card in 2 sign-in states, flat type steps on station Today |
| **Total** | | **15/20** | **Good** |

## Implementation Integrity Verdict
Pass. One token system (stage tokens on Kyle's Radix scales, shadcn variables), shared composites, lab-specific copy. Probe: 0 contrast failures across 47 runs (light and dark), 0 unnamed controls, 0 duplicate IDs, 0 skipped heading levels, main/nav/header landmarks everywhere, `lang="en"`, reduced-motion rules present. Detector: 10× radial-spotlight-glow on sign-in (Kyle's chosen gradient), 4× text-occlusion on SettingsModal (modal over its scrim, expected), 3× nested-cards (2 real), 1× flat-type-hierarchy advisory.

## Findings
- [P1] No layout below 1280 px or at 200 % zoom (all boards). WCAG 1.4.10, 1.4.4. Draw 1024 px Today, Inbox and shell; define the 640 px reflow. /impeccable adapt
- [P2] Sign-in failure states (no-methods, options-failed) have no heading; the "Sign in" h1 is inside the methods block. WCAG 1.3.1, 2.4.6. Keep the h1 in every state. /impeccable harden
- [P2] Switch 32×18 and row checkboxes 16×16 pass 2.5.8 by exception but miss the 44 px rule on stations. Give them 44 px hit areas on stations. /impeccable harden
- [P2] Layout-property animations: quick actions (grid-template-columns), table search (width). Move to transform/clip or document. /impeccable optimize
- [P3] Nested card on SignInNoMethods and SignInPickerEmpty. /impeccable polish
- [P3] Flat type steps on station Today (h2 16 px = body). /impeccable typeset
- [P3] 20 px tall text links ("Open Inbox", "All activity", "How LAB stations work"). /impeccable polish

## Positive findings
No contrast failures in light or dark; every control named; aria-sort on headings; named drawer handle; tokens everywhere; dark boards for every area; reduced motion handled.

## Recommended Actions
1. [P1] /impeccable adapt: 1024 px and 640 px reflow.
2. [P2] /impeccable harden: sign-in heading; 44 px station hit areas.
3. [P2] /impeccable optimize: the two width animations.
4. [P3] /impeccable typeset: station Today heading step.
5. /impeccable polish: nested cards, 24 px text links.
