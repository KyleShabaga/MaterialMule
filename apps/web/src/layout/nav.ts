import type { MeResponse } from '@trapezoid/shared';
import { FEATURES, type FeatureFlag } from '../features';

export interface NavItem {
  to: string;
  label: string;
  feature?: FeatureFlag;
}

/** Side menu in the order Kyle set on 2026-10-25 (TRP-T34, decision #8). */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/receiving-log', label: 'Receiving Log' },
  { to: '/sample-storage', label: 'Sample Storage' },
  { to: '/lab-testing-worklist', label: 'Lab Testing Worklist', feature: 'labTestingWorklist' },
  { to: '/testing-programs', label: 'Testing Programs', feature: 'testingPrograms' },
  { to: '/disposal-retention', label: 'Disposal & Retention', feature: 'disposalRetention' },
  { to: '/projects', label: 'Projects' },
  { to: '/settings', label: 'Settings' },
];

export function visibleNavItems(features: Record<FeatureFlag, boolean> = FEATURES): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.feature || features[item.feature]);
}

export function accountBadge(me: MeResponse): { label: string; tone: 'info' | 'warning' } {
  switch (me.accountType) {
    case 'shared_lab':
      return { label: 'Shared station: LAB', tone: 'info' };
    case 'test':
      return { label: 'TEST', tone: 'warning' };
    default:
      return { label: 'Personal', tone: 'info' };
  }
}
