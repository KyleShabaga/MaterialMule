import type { RouteObject } from 'react-router';
import { FEATURES } from './features';
import { ActionRequestsPage } from './action-requests/ActionRequestsPage';
import { DisposalPage } from './disposal/DisposalPage';
import { DisposalScanPage } from './disposal/DisposalScanPage';
import { InventoryPage } from './inventory/InventoryPage';
import { LabTestingLayout } from './lab/LabTestingLayout';
import { ProgramDetailPage } from './lab/ProgramDetailPage';
import { ProgramEditor } from './lab/ProgramEditor';
import { ProgramsPage } from './lab/ProgramsPage';
import { WorkedProgram } from './lab/WorkedProgram';
import { WorklistPage } from './lab/WorklistPage';
import { InventoryRedirect, StorageUnitRedirect } from './inventory/redirects';
import { StorageUnitDetailPage } from './inventory/StorageUnitDetailPage';
import { AppLayout } from './layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { MicrosoftCallbackPage } from './pages/MicrosoftCallbackPage';
import { PositionSetupPage } from './pages/PositionSetupPage';
import { ProfilePage } from './pages/ProfilePage';
import { SignInPage } from './pages/SignInPage';
import { LabelPrintPage } from './printing/LabelPrintPage';
import { PrintersSettingsPage } from './printing/PrintersSettingsPage';
import { ProjectDetailPage } from './projects/ProjectDetailPage';
import { ProjectsPage } from './projects/ProjectsPage';
import { TeamPermissionsPage } from './projects/TeamPermissionsPage';
import {
  AccessPendingPage,
  ErrorPage,
  NotFoundPage,
  RequireActiveSession,
  SettingsLayout,
} from './pages/simple-pages';
import { ReceiveSamplesPage } from './receiving/ReceiveSamplesPage';
import { ReceiptDetailPage } from './receiving-log/ReceiptDetailPage';
import { ReceivingLogPage } from './receiving-log/ReceivingLogPage';
import { MovePage } from './moves/MovePage';
import { ScanPage } from './scanning/ScanPage';
import { TemplatesSettingsPage, TestsSettingsPage } from './settings/lab/LabCatalogueSettings';
import { LocationsPage } from './settings/locations/LocationsPage';
import { ReceivingSettingsPage } from './settings/receiving/ReceivingSettingsPage';
import { MyAccessPage } from './settings/access/MyAccessPage';
import { StaffPage } from './settings/staff/StaffPage';
import { SystemStatusPage } from './settings/system-status/SystemStatusPage';
import { TestSignInPage } from './TestSignInPage';

const featureRoutes: RouteObject[] = [
  ...(FEATURES.labTesting
    ? [
        {
          // One Lab Testing area (MM-T23/T24): Worklist (default) and Programs tabs.
          path: 'lab-testing',
          element: <LabTestingLayout worklist />,
          children: [
            { index: true, element: <WorklistPage /> },
            { path: 'programs', element: <ProgramsPage /> },
            { path: 'programs/new', element: <ProgramEditor draft={null} /> },
            {
              path: 'programs/:programId',
              element: (
                <ProgramDetailPage
                  renderSubmitted={(program, reload) => (
                    <WorkedProgram program={program} reload={reload} />
                  )}
                />
              ),
            },
          ],
        },
      ]
    : []),
  ...(FEATURES.disposalRetention
    ? [
        {
          path: 'disposal-retention',
          element: <DisposalPage />,
        },
        // Distinct, online-only disposal scan mode (MM-T30); not Move mode.
        { path: 'disposal-retention/scan', element: <DisposalScanPage /> },
      ]
    : []),
];

export const routes: RouteObject[] = [
  {
    errorElement: <ErrorPage />,
    children: [
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/sign-in/test', element: <TestSignInPage /> },
      { path: '/sign-in/microsoft/callback', element: <MicrosoftCallbackPage /> },
      { path: '/onboarding/position', element: <PositionSetupPage /> },
      { path: '/access-pending', element: <AccessPendingPage /> },
      {
        element: <RequireActiveSession />,
        children: [
          // Label print views (MM-T39): no app chrome, one 3.5 x 1.5 in label per page.
          { path: '/labels/print/unit/:id', element: <LabelPrintPage scope="unit" /> },
          { path: '/labels/print/receipt/:id', element: <LabelPrintPage scope="receipt" /> },
          {
            path: '/',
            element: <AppLayout />,
            children: [
              { index: true, element: <DashboardPage /> },
              // Confirmed receipts and receipt detail (MM-T51); static `new` wins over :receiptId.
              { path: 'receiving-log', element: <ReceivingLogPage /> },
              { path: 'receiving-log/new', element: <ReceiveSamplesPage /> },
              { path: 'receiving-log/:receiptId', element: <ReceiptDetailPage /> },
              // Inventory and storage unit detail (MM-T12). The menu calls it Sample Storage; the
              // card's /inventory and /storage-units/:suNumber paths redirect here.
              { path: 'sample-storage', element: <InventoryPage /> },
              // Handheld scanner lookup mode (MM-T16); static, so it wins over :readableId.
              { path: 'sample-storage/scan', element: <ScanPage /> },
              // Destination scans and queued moves (MM-T28); static, like scan.
              { path: 'sample-storage/move', element: <MovePage /> },
              { path: 'sample-storage/:readableId', element: <StorageUnitDetailPage /> },
              { path: 'inventory', element: <InventoryRedirect /> },
              { path: 'storage-units/:suNumber', element: <StorageUnitRedirect /> },
              // Action requests inbox (MM-T27): personal accounts; the header bell links here.
              { path: 'action-requests', element: <ActionRequestsPage /> },
              // Projects list and detail (MM-T35).
              { path: 'projects', element: <ProjectsPage /> },
              { path: 'projects/:projectId', element: <ProjectDetailPage /> },
              { path: 'projects/:projectId/team', element: <TeamPermissionsPage /> },
              {
                path: 'settings',
                element: <SettingsLayout />,
                children: [
                  { index: true, element: <ProfilePage /> },
                  {
                    path: 'profile',
                    element: <ProfilePage />,
                  },
                  // Own roles, grants and project responsibilities (MM-AO06).
                  { path: 'access', element: <MyAccessPage /> },
                  { path: 'staff', element: <StaffPage /> },
                  // Storage locations and location labels (MM-T37).
                  { path: 'locations', element: <LocationsPage /> },
                  // Lab test catalogue and templates (MM-T23): everyone reads, Lab Manager/admin edit.
                  { path: 'tests', element: <TestsSettingsPage /> },
                  { path: 'templates', element: <TemplatesSettingsPage /> },
                  { path: 'printers', element: <PrintersSettingsPage /> },
                  // Draft auto-delete (MM-T45): Admin and Lab Manager.
                  { path: 'receiving', element: <ReceivingSettingsPage /> },
                  // Admin-only operational status (MM-T21).
                  { path: 'system-status', element: <SystemStatusPage /> },
                ],
              },
              ...featureRoutes,
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];
