import { useEffect, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';

// MTR-134: every page gets its own browser tab title, "<page> · <section> · Material Mule",
// e.g. "BKT-2026-000014 · Inventory · Material Mule" (WCAG 2.4.2). PageHeader and detail
// pages name the page with usePageTitle; otherwise the route's own label below is used.

const APP_NAME = 'Material Mule';

// Tab-title sections use the sidebar row names (nav.ts). Concrete breaks and holds live under
// /lab-testing but belong to Concrete, so they come first.
const SECTIONS: readonly { to: string; label: string }[] = [
  { to: '/lab-testing/concrete', label: 'Concrete' },
  { to: '/receiving-log', label: 'Receive' },
  { to: '/sample-storage', label: 'Inventory' },
  { to: '/lab-testing', label: 'Lab programs' },
  { to: '/disposal-retention', label: 'Retention' },
  { to: '/concrete', label: 'Concrete' },
  { to: '/projects', label: 'Projects' },
  { to: '/settings', label: 'Settings' },
  { to: '/inbox', label: 'Inbox' },
  { to: '/help', label: 'Help' },
];

const ROUTE_LABELS: readonly [RegExp, string][] = [
  [/^\/receiving-log$/, 'Receiving log'],
  [/^\/receiving-log\/new$/, 'Receive samples'],
  [/^\/sample-storage$/, 'Inventory'],
  [/^\/sample-storage\/scan$/, 'Scan labels'],
  [/^\/sample-storage\/move$/, 'Move storage units'],
  [/^\/lab-testing$/, 'Workboard'],
  [/^\/lab-testing\/programs$/, 'Programs'],
  [/^\/lab-testing\/programs\/new$/, 'New lab program'],
  [/^\/lab-testing\/programs\/[^/]+\/tags$/, 'Sample tags'],
  [/^\/lab-testing\/concrete$/, 'Breaks'],
  [/^\/lab-testing\/concrete\/holds$/, 'Holds'],
  [/^\/disposal-retention$/, 'Retention'],
  [/^\/disposal-retention\/scan$/, 'Disposal scan'],
  [/^\/concrete\/review$/, 'Review'],
  [/^\/concrete\/receiving$/, 'Receiving'],
  [/^\/concrete\/specimens$/, 'Specimens'],
  [/^\/concrete\/testing$/, 'Testing table'],
  [/^\/concrete\/search$/, 'Concrete search'],
  [/^\/projects\/[^/]+\/team$/, 'Team & Permissions'],
  [/^\/settings\/profile$/, 'My profile'],
  [/^\/settings\/access$/, 'My access'],
  [/^\/settings\/staff$/, 'Staff & access'],
  [/^\/settings\/locations$/, 'Locations'],
  [/^\/settings\/equipment$/, 'Equipment'],
  [/^\/settings\/suppliers$/, 'Suppliers'],
  [/^\/settings\/holidays$/, 'Holidays'],
  [/^\/settings\/report-header$/, 'Report header'],
  [/^\/settings\/tests$/, 'Tests'],
  [/^\/settings\/templates$/, 'Templates'],
  [/^\/settings\/printers$/, 'Printers'],
  [/^\/settings\/receiving$/, 'Receiving'],
  [/^\/settings\/system-status$/, 'System status'],
  [/^\/labels\/print\//, 'Print labels'],
  [/^\/sign-in/, 'Sign in'],
  [/^\/access-pending$/, 'Access pending'],
  [/^\/search$/, 'Search'],
];
function sectionFor(pathname: string): string | null {
  if (pathname === '/') return 'Today';
  const match = SECTIONS.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  return match?.label ?? null;
}

/** The page's own name: `title` when given, else the route's label, else its section. */
export function pageName(pathname: string, title?: string | null): string {
  return (
    title ||
    ROUTE_LABELS.find(([pattern]) => pattern.test(pathname))?.[1] ||
    sectionFor(pathname) ||
    APP_NAME
  );
}

/** The tab title for a path, naming the page `title` when given. */
export function pageTitle(pathname: string, title?: string | null): string {
  const label = title || ROUTE_LABELS.find(([pattern]) => pattern.test(pathname))?.[1] || null;
  const section = sectionFor(pathname);
  const parts = [label, section].filter((part): part is string => !!part);
  if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
  return [...parts, APP_NAME].join(' · ');
}

// The page title set for the current path, if any. Tied to its path, so a navigation that lands
// before or after the page's own effect still ends on the right title.
let named: { pathname: string; title: string; token: object } | null = null;
let currentPath = '/';
const namedListeners = new Set<() => void>();

function setNamed(next: typeof named): void {
  named = next;
  namedListeners.forEach((listener) => listener());
}

function subscribeNamed(listener: () => void): () => void {
  namedListeners.add(listener);
  return () => namedListeners.delete(listener);
}

/**
 * The current page's name for the top bar (STRATA-12): the title a page set with usePageTitle
 * (a record ID), else the route's label. Text only: the page keeps its own h1.
 */
export function useTopBarTitle(): string {
  const { pathname } = useLocation();
  const title = useSyncExternalStore(subscribeNamed, () =>
    named?.pathname === pathname ? named.title : null,
  );
  return pageName(pathname, title);
}

export function applyPageTitle(pathname: string): void {
  currentPath = pathname;
  document.title = pageTitle(pathname, named?.pathname === pathname ? named.title : null);
}

/** Names the current page in the tab title; null leaves the route's own label. */
export function usePageTitle(title: string | null | undefined): void {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!title) return;
    const token = {};
    setNamed({ pathname, title, token });
    applyPageTitle(pathname);
    return () => {
      if (named?.token !== token) return;
      setNamed(null);
      applyPageTitle(currentPath);
    };
  }, [title, pathname]);
}
