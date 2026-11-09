import type { MeResponse } from '@materialmule/shared';
import { FEATURES, type FeatureFlag } from '../features';

export interface NavItem {
  to: string;
  label: string;
  feature?: FeatureFlag;
}

/** Side menu in the order Kyle set on 2026-10-25 (MM-T34, decision #8). */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/receiving-log', label: 'Receiving Log' },
  { to: '/sample-storage', label: 'Sample Storage' },
  { to: '/lab-testing', label: 'Lab Testing', feature: 'labTesting' },
  { to: '/disposal-retention', label: 'Disposal & Retention', feature: 'disposalRetention' },
  { to: '/concrete/review', label: 'Concrete Review', feature: 'concreteReview' },
  // MM-V2-C31: the Concrete dashboard. Lab staff reach it from the Concrete Lab group instead.
  { to: '/concrete', label: 'Concrete', feature: 'concreteLab' },
  { to: '/projects', label: 'Projects' },
  { to: '/settings', label: 'Settings' },
];

export function visibleNavItems(features: Record<FeatureFlag, boolean> = FEATURES): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.feature || features[item.feature]);
}

/**
 * The Concrete Lab workspace (MM-V2-C31, the plan's proposal for the two concrete lab computers):
 * Receiving, Break worklist, Testing table (MM-V2-C23), Specimen lookup and Equipment, with the
 * Concrete dashboard first.
 * Names are distinct from the main menu's so no link name contains another's.
 */
export const CONCRETE_LAB_NAV_ITEMS: readonly NavItem[] = [
  { to: '/concrete', label: 'Concrete home' },
  { to: '/concrete/receiving', label: 'Specimen receiving' },
  { to: '/lab-testing/concrete', label: 'Break worklist' },
  // MM-V2-C23: direct entry of today's breaks.
  { to: '/concrete/testing', label: 'Testing table' },
  { to: '/concrete/specimens', label: 'Specimen lookup' },
  { to: '/settings/equipment', label: 'Concrete equipment' },
];

/**
 * Lab staff (MM-V2-C36): the Lab Technician role, Lab Managers and the shared LAB account. The
 * workspace is navigation only: it shows or hides nothing the server would allow or refuse.
 */
export function isConcreteLabStaff(me: Pick<MeResponse, 'accountType' | 'roles'>): boolean {
  return (
    me.accountType === 'shared_lab' ||
    me.roles.includes('lab_technician') ||
    me.roles.includes('lab_manager')
  );
}

/**
 * The menus a session sees: the main menu, then (lab staff) the Concrete Lab group, so the main
 * menu keeps its order and first link for everyone.
 */
export function navGroupsFor(
  me: Pick<MeResponse, 'accountType' | 'roles'>,
  features: Record<FeatureFlag, boolean> = FEATURES,
): { concreteLab: NavItem[]; main: NavItem[] } {
  const main = visibleNavItems(features);
  if (!features.concreteLab || !isConcreteLabStaff(me)) return { concreteLab: [], main };
  return {
    concreteLab: [...CONCRETE_LAB_NAV_ITEMS],
    main: main.filter((item) => item.to !== '/concrete'),
  };
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
