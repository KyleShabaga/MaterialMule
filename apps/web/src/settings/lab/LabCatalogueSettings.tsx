import { LabTestsPage } from './LabTestsPage';
import { TemplatesPanel } from './TemplatesPanel';

// Old names, kept until settings/modal/panels.tsx and admin/AdminLayout.tsx import the Strata
// components directly (STRATA-102/128).

/** @deprecated Use LabTestsPage. */
export const TestsSettingsPage = LabTestsPage;
/** @deprecated Use TemplatesPanel. */
export const TemplatesSettingsPage = TemplatesPanel;
