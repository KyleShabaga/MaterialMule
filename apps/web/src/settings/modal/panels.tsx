import type { ComponentType } from 'react';
import { AccessPanel, NotificationsPanel, PreferencesPanel, ProfilePanel } from '../account';
import { EquipmentPanel } from '../equipment';
import { TemplatesPanel } from '../lab';
import { PrintersPanel } from '../printers';
import { ReceivingPanel } from '../receiving';
import { HolidaysPanel, ReportHeaderPanel, SuppliersPanel } from '../reference';
import { SystemStatusPanel } from '../system-status';

/** Admin sections in the modal (STRATA-102): each renders one SettingsPanel that scrolls inside. */
const ADMIN_PANELS: Record<string, ComponentType> = {
  printers: PrintersPanel,
  templates: TemplatesPanel,
  receiving: ReceivingPanel,
  equipment: EquipmentPanel,
  suppliers: SuppliersPanel,
  holidays: HolidaysPanel,
  'report-header': ReportHeaderPanel,
  // Includes the administrator's "This computer is the LAB station" switch (STRATA-18).
  'system-status': SystemStatusPanel,
};

/** The panel for one modal section (the three page sections never reach here). */
export function SettingsPanelFor({
  slug,
  blockedSection,
}: {
  slug: string;
  blockedSection?: string;
}) {
  switch (slug) {
    case 'profile':
      return <ProfilePanel />;
    case 'preferences':
      return <PreferencesPanel />;
    case 'notifications':
      return <NotificationsPanel />;
    case 'access':
      return <AccessPanel blockedSection={blockedSection} />;
  }
  const Panel = ADMIN_PANELS[slug];
  return Panel ? <Panel /> : null;
}
