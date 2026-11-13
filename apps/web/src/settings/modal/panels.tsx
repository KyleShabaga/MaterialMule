import type { ComponentType, ReactNode } from 'react';
import { PrintersSettingsPage } from '../../printing/PrintersSettingsPage';
import { AccessPanel, NotificationsPanel, PreferencesPanel, ProfilePanel } from '../account';
import { EquipmentSettingsPage } from '../equipment/EquipmentSettingsPage';
import { TemplatesSettingsPage } from '../lab/LabCatalogueSettings';
import { ReceivingSettingsPage } from '../receiving/ReceivingSettingsPage';
import { HolidaysSettingsPage } from '../reference/HolidaysSettingsPage';
import { ReportHeaderSettingsPage } from '../reference/ReportHeaderSettingsPage';
import { SuppliersSettingsPage } from '../reference/SuppliersSettingsPage';
import { LabStationSwitch } from '../system-status/LabStationSwitch';
import { SystemStatusPage } from '../system-status/SystemStatusPage';

/**
 * A section's existing content inside the modal: it scrolls in the panel and keeps its own
 * heading and controls. Each admin section is restyled as a Strata panel by STRATA-102.
 */
function Scrolling({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-6 pt-10 pb-16 md:px-10"
      data-settings-panel={slug}
    >
      <div className="settings-content mx-auto max-w-[1040px] pr-8">{children}</div>
    </div>
  );
}

const ADMIN_PANELS: Record<string, ComponentType> = {
  printers: PrintersSettingsPage,
  templates: TemplatesSettingsPage,
  receiving: ReceivingSettingsPage,
  equipment: EquipmentSettingsPage,
  suppliers: SuppliersSettingsPage,
  holidays: HolidaysSettingsPage,
  'report-header': ReportHeaderSettingsPage,
  'system-status': SystemStatusPage,
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
  if (!Panel) return null;
  return (
    <Scrolling slug={slug}>
      <Panel />
      {slug === 'system-status' ? <LabStationSwitch /> : null}
    </Scrolling>
  );
}
