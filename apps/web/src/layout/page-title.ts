import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { NAV_ITEMS } from './nav';

// MTR-134: every page gets its own browser tab title, "<page> · <section> · Material Mule",
// e.g. "BKT-2026-000014 · Sample Storage · Material Mule" (WCAG 2.4.2). PageHeader and detail
// pages name the page with usePageTitle; otherwise the route's own label below is used.

const APP_NAME = 'Material Mule';

const EXTRA_SECTIONS: readonly { to: string; label: string }[] = [
  { to: '/action-requests', label: 'Action requests' },
];

const ROUTE_LABELS: readonly [RegExp, string][] = [
  [/^\/receiving-log\/new$/, 'Receive samples'],
  [/^\/sample-storage\/scan$/, 'Scan labels'],
  [/^\/sample-storage\/move$/, 'Move storage units'],
  [/^\/lab-testing$/, 'Worklist'],
  [/^\/lab-testing\/programs$/, 'Programs'],
  [/^\/lab-testing\/programs\/new$/, 'New program'],
  [/^\/lab-testing\/programs\/[^/]+\/tags$/, 'Sample tags'],
  [/^\/disposal-retention\/scan$/, 'Disposal scan'],
  [/^\/projects\/[^/]+\/team$/, 'Team & Permissions'],
  [/^\/settings\/profile$/, 'My profile'],
  [/^\/settings\/access$/, 'My access'],
  [/^\/settings\/staff$/, 'Staff & access'],
  [/^\/settings\/locations$/, 'Locations'],
  [/^\/settings\/tests$/, 'Tests'],
  [/^\/settings\/templates$/, 'Templates'],
  [/^\/settings\/printers$/, 'Printers'],
  [/^\/settings\/receiving$/, 'Receiving'],
  [/^\/settings\/system-status$/, 'System status'],
  [/^\/labels\/print\//, 'Print labels'],
  [/^\/sign-in/, 'Sign in'],
  [/^\/access-pending$/, 'Access pending'],
  [/^\/onboarding\/position$/, 'Welcome'],
];

function sectionFor(pathname: string): string | null {
  if (pathname === '/') return 'Dashboard';
  const match = [...NAV_ITEMS, ...EXTRA_SECTIONS]
    .filter((item) => item.to !== '/')
    .find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  return match?.label ?? null;
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
    named = { pathname, title, token };
    applyPageTitle(pathname);
    return () => {
      if (named?.token !== token) return;
      named = null;
      applyPageTitle(currentPath);
    };
  }, [title, pathname]);
}
