import type { RouteObject } from 'react-router';
import { FEATURES } from './features';
import { AppLayout } from './layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { SignInPage } from './pages/SignInPage';
import { StaffPage } from './pages/StaffPage';
import {
  AccessPendingPage,
  ErrorPage,
  NotFoundPage,
  PlaceholderPage,
  RequireActiveSession,
  SettingsLayout,
} from './pages/simple-pages';
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
                element: <PlaceholderPage title="Receive samples" card="TRP-T10" />,
              },
              {
                path: 'sample-storage',
                element: <PlaceholderPage title="Sample Storage" card="TRP-T12" />,
              },
              { path: 'projects', element: <PlaceholderPage title="Projects" card="TRP-T35" /> },
              {
                path: 'settings',
                element: <SettingsLayout />,
                children: [
                  { index: true, element: <PlaceholderPage title="My profile" card="TRP-T05" /> },
                  {
                    path: 'profile',
                    element: <PlaceholderPage title="My profile" card="TRP-T05" />,
                  },
                  { path: 'staff', element: <StaffPage /> },
                  {
                    path: 'locations',
                    element: <PlaceholderPage title="Locations" card="TRP-T37" />,
                  },
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
