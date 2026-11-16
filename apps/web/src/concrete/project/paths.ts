// MM-V2-C30, STRATA-98: addresses of the project's Concrete tab and its sub-tabs.

/** The Concrete tab's sub-tabs (Kyle 2026-11-11), each its own address. */
export const CONCRETE_TABS = [
  { key: 'reports', label: 'Field reports' },
  { key: 'sets', label: 'Sets' },
  { key: 'mixes', label: 'Mixes' },
  { key: 'summary', label: 'Summary' },
  { key: 'settings', label: 'Settings' },
] as const;
export type ConcreteTab = (typeof CONCRETE_TABS)[number]['key'];

/** Former sub-tab addresses that now open another sub-tab. */
export const LEGACY_CONCRETE_TABS: Record<string, ConcreteTab> = { specimens: 'sets' };

export const concreteTabPath = (projectId: string, tab: ConcreteTab = 'reports') =>
  `/projects/${encodeURIComponent(projectId)}/concrete/${tab}`;

export const mixPath = (projectId: string, mixId: string) =>
  `/projects/${encodeURIComponent(projectId)}/concrete/mixes/${encodeURIComponent(mixId)}`;

export const propagationPath = (projectId: string, mixId: string) =>
  `${mixPath(projectId, mixId)}/propagation`;

/** A field report's page (review, issue, correction). */
export const fieldReportPath = (reportId: string) =>
  `/concrete/review/${encodeURIComponent(reportId)}`;

/** A specimen set's page (round 7). */
export const setPath = (setId: string) => `/concrete/specimens/${encodeURIComponent(setId)}`;
