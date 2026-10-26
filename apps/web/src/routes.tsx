import type { RouteObject } from 'react-router';
import { FEATURES } from './features';
import { InventoryPage } from './inventory/InventoryPage';
import { InventoryRedirect, StorageUnitRedirect } from './inventory/redirects';
import { StorageUnitDetailPage } from './inventory/StorageUnitDetailPage';
import { AppLayout } from './layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { MicrosoftCallbackPage } from './pages/MicrosoftCallbackPage';
import { PositionSetupPage } from './pages/PositionSetupPage';
import { ProfilePage } from './pages/ProfilePage';
import { SignInPage } from './pages/SignInPage';
import { PrintersSettingsPage } from './printing/PrintersSettingsPage';
import { ProjectDetailPage } from './projects/ProjectDetailPage';
import { ProjectsPage } from './projects/ProjectsPage';
import {
  AccessPendingPage,
  ErrorPage,
  NotFoundPage,
  PlaceholderPage,
  RequireActiveSession,
  SettingsLayout,
} from './pages/simple-pages';
import { ReceiveSamplesPage } from './receiving/ReceiveSamplesPage';
import { ScanPage } from './scanning/ScanPage';
import { StaffPage } from './settings/staff/StaffPage';
import { SystemStatusPage } from './settings/system-status/SystemStatusPage';
import { TestSignInPage } from './TestSignInPage';

const featureRoutes: RouteObject[] = [
  ...(FEATURES.labTestingWorklist
    ? [
        {
          path: 'lab-testing-worklist',
          element: <PlaceholderPage title="Lab Testing Worklist" card="TRP-T24" />,
        },
      ]
    : []),
  ...(FEATURES.testingPrograms
    ? [
        {
          path: 'testing-programs',
          element: <PlaceholderPage title="Testing Programs" card="TRP-T23" />,
        },
      ]
    : []),
  ...(FEATURES.disposalRetention
    ? [
        {
          path: 'disposal-retention',
          element: <PlaceholderPage title="Disposal & Retention" card="TRP-T29" />,
        },
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
          {
            path: '/',
            element: <AppLayout />,
            children: [
              { index: true, element: <DashboardPage /> },
              {
                path: 'receiving-log',
                element: <PlaceholderPage title="Receiving Log" card="TRP-T10" />,
              },
              { path: 'receiving-log/new', element: <ReceiveSamplesPage /> },
              // Inventory and storage unit detail (TRP-T12). The menu calls it Sample Storage; the
              // card's /inventory and /storage-units/:suNumber paths redirect here.
              { path: 'sample-storage', element: <InventoryPage /> },
              // Handheld scanner lookup mode (TRP-T16); static, so it wins over :readableId.
              { path: 'sample-storage/scan', element: <ScanPage /> },
              { path: 'sample-storage/:readableId', element: <StorageUnitDetailPage /> },
              { path: 'inventory', element: <InventoryRedirect /> },
              { path: 'storage-units/:suNumber', element: <StorageUnitRedirect /> },
              // Projects list and detail (TRP-T35).
              { path: 'projects', element: <ProjectsPage /> },
              { path: 'projects/:projectId', element: <ProjectDetailPage /> },
              {
                path: 'settings',
                element: <SettingsLayout />,
                children: [
                  { index: true, element: <ProfilePage /> },
                  {
                    path: 'profile',
                    element: <ProfilePage />,
                  },
                  { path: 'staff', element: <StaffPage /> },
                  {
                    path: 'locations',
                    element: <PlaceholderPage title="Locations" card="TRP-T37" />,
                  },
                  { path: 'printers', element: <PrintersSettingsPage /> },
                  // Admin-only operational status (TRP-T21).
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
