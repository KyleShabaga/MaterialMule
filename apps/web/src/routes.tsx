import type { RouteObject } from 'react-router';
import { FEATURES } from './features';
import { AppLayout } from './layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { MicrosoftCallbackPage } from './pages/MicrosoftCallbackPage';
import { PositionSetupPage } from './pages/PositionSetupPage';
import { ProfilePage } from './pages/ProfilePage';
import { SignInPage } from './pages/SignInPage';
import { PrintersSettingsPage } from './printing/PrintersSettingsPage';
import { StorageUnitLabelsPage } from './printing/StorageUnitLabelsPage';
import { StaffPage } from './pages/StaffPage';
import {
  AccessPendingPage,
  ErrorPage,
  NotFoundPage,
  PlaceholderPage,
  RequireActiveSession,
  SettingsLayout,
} from './pages/simple-pages';
import { ReceiveSamplesPage } from './receiving/ReceiveSamplesPage';
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
              {
                path: 'receiving-log/new',
                element: <ReceiveSamplesPage />,
              },
              {
                path: 'sample-storage',
                element: <PlaceholderPage title="Sample Storage" card="TRP-T12" />,
              },
              { path: 'sample-storage/:readableId', element: <StorageUnitLabelsPage /> },
              { path: 'projects', element: <PlaceholderPage title="Projects" card="TRP-T35" /> },
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
