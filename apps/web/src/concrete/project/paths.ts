// MM-V2-C30: addresses of the project Concrete section.

export const CONCRETE_TABS = [
  { key: 'reports', label: 'Reports' },
  { key: 'specimens', label: 'Specimens' },
  { key: 'summary', label: 'Summary' },
  { key: 'mixes', label: 'Mixes' },
  { key: 'settings', label: 'Settings' },
] as const;
export type ConcreteTab = (typeof CONCRETE_TABS)[number]['key'];

export const concreteTabPath = (projectId: string, tab: ConcreteTab = 'reports') =>
  `/projects/${encodeURIComponent(projectId)}/concrete/${tab}`;

export const mixPath = (projectId: string, mixId: string) =>
  `/projects/${encodeURIComponent(projectId)}/concrete/mixes/${encodeURIComponent(mixId)}`;

export const propagationPath = (projectId: string, mixId: string) =>
  `${mixPath(projectId, mixId)}/propagation`;
