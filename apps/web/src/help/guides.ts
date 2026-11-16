import { FEATURES, type FeatureFlag } from '../features';

// Help content (STRATA-103, round 10). One module so the copy has one owner: who writes and
// approves it is still open (STRATA-68). Every guide written for Strata carries
// `placeholder: true` so it can be listed and replaced; guides kept word for word from the
// Field Ledger Help page carry `placeholder: false`. Nothing here describes gated or unbuilt
// work (offline field entry, final reports, G2/G8, D38 session length) as built.

export type HelpGroupId =
  'getting-around' | 'receiving' | 'storage' | 'lab-tests' | 'concrete' | 'access';

export interface HelpGroup {
  id: HelpGroupId;
  label: string;
  /** Lucide icon name, resolved by the components (help-content.tsx). */
  icon: 'compass' | 'arrow-down-to-line' | 'package' | 'flask-conical' | 'cylinder' | 'key-round';
  /** Shown only when this flag is on. */
  feature?: FeatureFlag;
}

export interface HelpGuide {
  /** Stable anchor on /help (`/help#<id>`); never rename one that is linked from elsewhere. */
  id: string;
  group: HelpGroupId;
  title: string;
  /** Numbered task steps. */
  steps?: string[];
  /** A short paragraph, when the answer isn't a sequence of steps. */
  body?: string;
  /** A line under the steps. */
  note?: string;
  /** Not built: shown with an "Open item" badge, never as a working task. */
  openItem?: boolean;
  /** New Strata copy awaiting its owner (STRATA-68). False: kept from the Field Ledger page. */
  placeholder: boolean;
  feature?: FeatureFlag;
}

export interface HelpQuestion {
  id: string;
  q: string;
  a: string;
  placeholder: boolean;
}

/** The five groups from the brief plus "Getting around" (round 10, so the sidebar has a home). */
export const HELP_GROUPS: readonly HelpGroup[] = [
  { id: 'getting-around', label: 'Getting around', icon: 'compass' },
  { id: 'receiving', label: 'Receiving', icon: 'arrow-down-to-line' },
  { id: 'storage', label: 'Shelves, labels and retention', icon: 'package' },
  { id: 'lab-tests', label: 'Lab tests', icon: 'flask-conical', feature: 'labTesting' },
  { id: 'concrete', label: 'Concrete', icon: 'cylinder', feature: 'concreteLab' },
  { id: 'access', label: 'Access and accounts', icon: 'key-round' },
];

export const HELP_GUIDES: readonly HelpGuide[] = [
  // ---- Getting around ----
  {
    id: 'sidebar',
    group: 'getting-around',
    title: 'How the sidebar works',
    steps: [
      'Today, Projects and Inbox are always at the top.',
      'Click a section’s name to fold it or open it again.',
      'To reorder or hide sections, choose Customize sidebar, then Done.',
      'Press Ctrl B to collapse the sidebar to icons, and again to expand it.',
    ],
    placeholder: true,
  },
  {
    id: 'search',
    group: 'getting-around',
    title: 'Search or scan anything',
    body: 'Press Ctrl K, then type an ID, a project number or a page, or scan a label. One matching unit or shelf opens straight away.',
    placeholder: true,
  },
  {
    id: 'inbox',
    group: 'getting-around',
    title: 'Inbox and the bell',
    body: 'Requests waiting on you and updates about your work land in Inbox. The bell shows how many are unread.',
    placeholder: true,
  },

  // ---- Receiving ----
  {
    id: 'receive',
    group: 'receiving',
    title: 'Receive a delivery',
    body: 'Choose the project, add each storage unit with its samples per test hole, then Confirm receipt to issue the IDs.',
    placeholder: false,
  },
  {
    id: 'finish-draft',
    group: 'receiving',
    title: 'Finish a draft receipt',
    steps: [
      'Open Receive and continue the draft.',
      'Check each storage unit and its test hole summary.',
      'Confirm the receipt. A draft has no ID until then.',
    ],
    placeholder: true,
  },
  {
    id: 'put-away',
    group: 'receiving',
    title: 'Put units away after receiving',
    steps: ['Open Move storage units.', 'Scan the units and the shelf, in either order.'],
    placeholder: true,
  },

  // ---- Shelves, labels and retention ----
  {
    id: 'find-unit',
    group: 'storage',
    title: 'Find a unit',
    steps: [
      'Scan the label, or type the ID in Search or scan (Ctrl K).',
      'One match opens the unit. More than one shows a list.',
    ],
    placeholder: true,
  },
  {
    id: 'move',
    group: 'storage',
    title: 'Move units',
    steps: [
      'Choose Move storage units, or press Ctrl K and type Move.',
      'Scan the units and the shelf, in either order.',
      'Check the list, then confirm the move.',
    ],
    note: 'A unit’s ID stays the same wherever it goes.',
    placeholder: true,
  },
  {
    id: 'reprint-label',
    group: 'storage',
    title: 'Reprint a label',
    body: 'Open the unit from Inventory, then choose Reprint label in its Labels section.',
    placeholder: false,
  },
  {
    id: 'correct-unit',
    group: 'storage',
    title: 'Fix a mistake on a unit',
    body: 'Open the unit and choose Correct details, with a reason. The ID stays the same.',
    placeholder: false,
  },
  {
    id: 'retention-due',
    group: 'storage',
    title: 'Units due for a retention decision',
    body: 'Retention lists the units whose retention date has come or passed. Each one needs a decision before it can be disposed of.',
    placeholder: true,
    feature: 'disposalRetention',
  },
  {
    id: 'dispose',
    group: 'storage',
    title: 'Dispose of units',
    body: 'Approve the units that are due for disposal, then scan each one out on Disposal scan.',
    placeholder: false,
    feature: 'disposalRetention',
  },

  // ---- Lab tests ----
  {
    id: 'lab-request',
    group: 'lab-tests',
    title: 'Ask the lab for tests',
    body: 'Choose the project, list the samples and tests for each unit, then Submit program.',
    placeholder: false,
    feature: 'labTesting',
  },
  {
    id: 'workboard',
    group: 'lab-tests',
    title: 'Work through the Workboard',
    body: 'Workboard lists the lab programs waiting on the lab. Open one to record its progress.',
    placeholder: true,
    feature: 'labTesting',
  },
  {
    id: 'sample-tags',
    group: 'lab-tests',
    title: 'Print sample tags',
    body: 'Open the lab program and choose Sample tags to print a sheet of tags for its samples.',
    placeholder: true,
    feature: 'labTesting',
  },

  // ---- Concrete ----
  {
    id: 'concrete-receive',
    group: 'concrete',
    title: 'Receive concrete sets',
    body: 'Open Receiving under Concrete, find the field report, then check each specimen in.',
    placeholder: true,
    feature: 'concreteLab',
  },
  {
    id: 'concrete-breaks',
    group: 'concrete',
    title: 'Record breaks',
    body: 'Open Breaks, pick the set due today and enter each specimen’s result.',
    placeholder: true,
    feature: 'concreteLab',
  },
  {
    id: 'concrete-review',
    group: 'concrete',
    title: 'Review a field report',
    body: 'Open Review and choose the report. A field report is reviewed by the project’s Lead or a designated reviewer, never by the person who wrote it.',
    placeholder: true,
    feature: 'concreteReview',
  },
  {
    id: 'strength-reports',
    group: 'concrete',
    title: 'Strength and final reports',
    body: 'Not written yet: guides for strength and final reports wait on G2 and the report templates.',
    openItem: true,
    placeholder: true,
    feature: 'concreteLab',
  },

  // ---- Access and accounts ----
  {
    id: 'sign-in',
    group: 'access',
    title: 'Sign in for the first time',
    steps: [
      'On the office network, open Material Mule and choose Sign in with Microsoft.',
      'Use your work account.',
      'If it says you are not set up yet, an administrator approves you in Settings, Staff, Pending.',
    ],
    placeholder: true,
  },
  {
    id: 'lab-stations',
    group: 'access',
    title: 'How LAB stations work',
    body: 'A LAB station is a shared computer in the receiving lab. It stays signed in as LAB, and each person picks their own name so their work is recorded under it.',
    steps: [
      'On “Who is working here?”, choose your name. Not listed? Choose Someone else… and find it.',
      'Work as usual. The top bar says “Recording as” with your name the whole time.',
      'When you leave, open your name and choose Sign off. The station goes back to “Who is working here?”.',
    ],
    placeholder: true,
  },
  {
    id: 'my-access',
    group: 'access',
    title: 'See what you can do',
    body: 'Settings, My access lists your roles and the projects you have a responsibility on. To change them, ask an administrator.',
    placeholder: true,
  },
  {
    id: 'lab-password',
    group: 'access',
    title: 'Forgot the LAB password?',
    body: 'Ask an administrator.',
    placeholder: true,
  },
];

/** Common questions: two from DESIGN.md (round 10), two kept from the Field Ledger page. */
export const HELP_QUESTIONS: readonly HelpQuestion[] = [
  {
    id: 'id-change',
    q: 'Does an ID ever change?',
    a: 'No. A correction changes the details and keeps the ID.',
    placeholder: false,
  },
  {
    id: 'from-home',
    q: 'Does it work from home?',
    a: 'No. It runs on the office network only.',
    placeholder: false,
  },
  {
    id: 'draft-id',
    q: 'Why does a draft have no ID?',
    a: 'IDs are issued when the delivery is confirmed, so a number is never used for something that did not arrive.',
    placeholder: false,
  },
  {
    id: 'samples',
    q: 'Where do individual samples go?',
    a: 'Only in a lab program. Receiving records one summary per test hole.',
    placeholder: false,
  },
];

export interface HelpShortcut {
  keys: string[];
  /** Words between keys: "or" for alternatives; omitted, the keys are pressed together. */
  joiner?: 'or';
  what: string;
}

/** Keyboard shortcuts (round 10: Ctrl K, Ctrl B, ?, J/K, Esc). `mod` is Ctrl or ⌘. */
export function helpShortcuts(mod: string): { anywhere: HelpShortcut[]; lists: HelpShortcut[] } {
  return {
    anywhere: [
      { keys: [`${mod} K`, '/'], joiner: 'or', what: 'Search or scan' },
      { keys: [`${mod} B`], what: 'Collapse or expand the sidebar' },
      { keys: ['?'], what: 'Open or close Help' },
      { keys: ['Esc'], what: 'Close a drawer, menu or dialog' },
    ],
    lists: [{ keys: ['J', 'K'], what: 'Next and previous record in a drawer' }],
  };
}

export const SHORTCUTS_ANCHOR = 'keyboard-shortcuts';

/** How many rows Keyboard shortcuts lists (its count in All guides), "Just scan" included. */
export function shortcutCount(): number {
  const { anywhere, lists } = helpShortcuts('Ctrl');
  return anywhere.length + lists.length + 1;
}

/** Groups whose feature is on, each with its guides (feature flags only: no account needed). */
export function visibleGroups(
  features: Record<FeatureFlag, boolean> = FEATURES,
): { group: HelpGroup; guides: HelpGuide[] }[] {
  return HELP_GROUPS.filter((group) => !group.feature || features[group.feature])
    .map((group) => ({
      group,
      guides: HELP_GUIDES.filter(
        (guide) => guide.group === group.id && (!guide.feature || features[guide.feature]),
      ),
    }))
    .filter((entry) => entry.guides.length > 0);
}

export function guideById(id: string): HelpGuide | undefined {
  return HELP_GUIDES.find((guide) => guide.id === id);
}

export function groupById(id: string): HelpGroup | undefined {
  return HELP_GROUPS.find((group) => group.id === id);
}

/** The anchor of a group's section on /help. */
export function groupAnchor(id: HelpGroupId): string {
  return `group-${id}`;
}

/** Every guide whose title, steps, body, note or group name contains the query (any case). */
export function searchGuides(
  query: string,
  features: Record<FeatureFlag, boolean> = FEATURES,
): HelpGuide[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return visibleGroups(features).flatMap(({ group, guides }) =>
    guides.filter((guide) =>
      [group.label, guide.title, guide.body, guide.note, ...(guide.steps ?? [])]
        .filter((text): text is string => !!text)
        .some((text) => text.toLowerCase().includes(q)),
    ),
  );
}

export interface PageHelp {
  /** The page's name, for "Help for <label>". */
  label: string;
  /** Guides for this page, most useful first (the first one starts open). */
  guides: string[];
}

/**
 * Route → "help for this page". The first matching prefix wins, so more specific paths come
 * first. Anything else gets Getting around.
 */
const PAGE_HELP: readonly { match: RegExp; help: PageHelp }[] = [
  { match: /^\/$/, help: { label: 'Today', guides: ['search', 'receive', 'inbox'] } },
  {
    match: /^\/sample-storage\/move$/,
    help: { label: 'Move units', guides: ['move', 'put-away', 'find-unit'] },
  },
  {
    match: /^\/sample-storage\/scan$/,
    help: { label: 'Scan labels', guides: ['find-unit', 'move'] },
  },
  {
    match: /^\/sample-storage(\/|$)|^\/labels\//,
    help: { label: 'Inventory', guides: ['find-unit', 'move', 'reprint-label', 'correct-unit'] },
  },
  {
    match: /^\/receiving-log(\/|$)/,
    help: { label: 'Receive', guides: ['receive', 'finish-draft', 'put-away'] },
  },
  {
    match: /^\/lab-testing\/concrete(\/|$)/,
    help: { label: 'Breaks', guides: ['concrete-breaks', 'concrete-receive'] },
  },
  {
    match: /^\/lab-testing(\/|$)/,
    help: { label: 'Lab programs', guides: ['lab-request', 'workboard', 'sample-tags'] },
  },
  {
    match: /^\/concrete\/review(\/|$)/,
    help: { label: 'Review', guides: ['concrete-review', 'strength-reports'] },
  },
  {
    match: /^\/concrete(\/|$)/,
    help: {
      label: 'Concrete',
      guides: ['concrete-receive', 'concrete-breaks', 'concrete-review'],
    },
  },
  {
    match: /^\/disposal-retention(\/|$)/,
    help: { label: 'Retention', guides: ['retention-due', 'dispose'] },
  },
  {
    match: /^\/projects(\/|$)/,
    help: { label: 'Projects', guides: ['search', 'receive', 'lab-request'] },
  },
  {
    match: /^\/(notifications|action-requests)(\/|$)/,
    help: { label: 'Inbox', guides: ['inbox'] },
  },
  {
    match: /^\/settings(\/|$)/,
    help: { label: 'Settings', guides: ['my-access', 'lab-stations', 'sign-in'] },
  },
];

const GETTING_AROUND: PageHelp = {
  label: 'Getting around',
  guides: ['sidebar', 'search', 'inbox'],
};

/**
 * Help for the page at `pathname`, keeping only guides whose feature is on. `heading` is "Help
 * for <page>", or "Getting around" for a page without its own help.
 */
export function pageHelp(
  pathname: string,
  features: Record<FeatureFlag, boolean> = FEATURES,
): { heading: string; guides: HelpGuide[] } {
  const help = PAGE_HELP.find((entry) => entry.match.test(pathname))?.help;
  const guides = (help?.guides ?? [])
    .map(guideById)
    .filter((guide): guide is HelpGuide => !!guide && (!guide.feature || features[guide.feature]));
  if (help && guides.length > 0) return { heading: `Help for ${help.label}`, guides };
  return {
    heading: GETTING_AROUND.label,
    guides: GETTING_AROUND.guides.map((id) => guideById(id)!),
  };
}
