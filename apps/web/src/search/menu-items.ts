import type { MeResponse } from '@materialmule/shared';
import {
  ArrowDownToLine,
  ArrowRightLeft,
  FolderPlus,
  type LucideIcon,
  Printer,
} from 'lucide-react';
import { FEATURES, type FeatureFlag } from '../features';
import { destinationsFor } from '../layout/nav';

// What the Ctrl K menu and Quick actions offer. Courtesy only: an item this person can't use is
// hidden, using the same `me.permissions` the pages check; the server enforces every action.

export interface MenuLink {
  key: string;
  label: string;
  to: string;
  icon?: LucideIcon;
}

type Me = Pick<MeResponse, 'permissions' | 'accountType' | 'roles'>;
const can = (me: Me, permission: string) => me.permissions.includes(permission);

/** Receive starts a new receipt. */
export const RECEIVE_PATH = '/receiving-log/new';
/**
 * Projects are created inside Receive's project picker ("Add a project"); there is no second
 * project model. `project=new` asks Receive to open that form (see the lane report).
 */
export const NEW_PROJECT_PATH = '/receiving-log/new?new=1&project=new';

/** Which Quick actions this person may use (the server still checks each). */
export function quickActionItems(permissions: readonly string[]): {
  receive: boolean;
  newProject: boolean;
} {
  const receive = permissions.includes('receipt.draft');
  return { receive, newProject: receive && permissions.includes('project.create') };
}

/** The Actions group: Receive storage units, Move storage units, Print labels, New project. */
export function menuActions(me: Me): MenuLink[] {
  const items: (MenuLink | false)[] = [
    can(me, 'receipt.draft') && {
      key: 'receive',
      label: 'Receive storage units',
      to: RECEIVE_PATH,
      icon: ArrowDownToLine,
    },
    can(me, 'storage_unit.move') && {
      key: 'move',
      label: 'Move storage units',
      to: '/sample-storage/move',
      icon: ArrowRightLeft,
    },
    // Labels print from a selection: Inventory → tick units → Print labels.
    can(me, 'label.print') &&
      can(me, 'inventory.read') && {
        key: 'print',
        label: 'Print labels',
        to: '/sample-storage',
        icon: Printer,
      },
    can(me, 'project.create') &&
      can(me, 'receipt.draft') && {
        key: 'new-project',
        label: 'New project',
        to: NEW_PROJECT_PATH,
        icon: FolderPlus,
      },
  ];
  return items.filter((item): item is MenuLink => item !== false);
}

/** The Go to group: the sidebar's destinations and their sub-pages, plus Inbox and Settings. */
export function menuPages(me: Me, features: Record<FeatureFlag, boolean> = FEATURES): MenuLink[] {
  const pages: MenuLink[] = [];
  for (const destination of destinationsFor(me, features)) {
    pages.push({ key: destination.key, label: destination.label, to: destination.to });
    for (const child of destination.children) {
      if (child.to === destination.to) continue;
      pages.push({
        key: `${destination.key}:${child.to}`,
        label: `${destination.label} › ${child.label}`,
        to: child.to,
      });
    }
  }
  if (can(me, 'action_item.read'))
    pages.push({ key: 'inbox', label: 'Inbox', to: '/action-requests' });
  pages.push({ key: 'settings', label: 'Settings', to: '/settings' });
  return pages;
}

/** Case-insensitive: every word of the query appears in the label. */
export function matchesLabel(label: string, query: string): boolean {
  const haystack = label.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** "⌘K" on Apple keyboards, "Ctrl K" everywhere else. */
export function commandShortcutLabel(): string {
  const platform =
    typeof navigator === 'undefined'
      ? ''
      : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ?? navigator.platform);
  return /mac|iphone|ipad/i.test(platform) ? '⌘K' : 'Ctrl K';
}
