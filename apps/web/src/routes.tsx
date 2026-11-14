import { Navigate, type RouteObject } from 'react-router';
import { FEATURES } from './features';
import { ActionRequestsPage } from './action-requests/ActionRequestsPage';
import { NotificationsPage } from './notifications/NotificationsPage';
import { DisposalPage } from './disposal/DisposalPage';
import { DisposalScanPage } from './disposal/DisposalScanPage';
import { InventoryPage } from './inventory/InventoryPage';
import { LabTestingLayout } from './lab/LabTestingLayout';
import { ProgramDetailPage } from './lab/ProgramDetailPage';
import { ProgramEditor } from './lab/ProgramEditor';
import { ProgramsPage } from './lab/ProgramsPage';
import { SampleTagsPage } from './lab/SampleTagsPage';
import { WorkedProgram } from './lab/WorkedProgram';
import { WorklistPage } from './lab/WorklistPage';
import { ConcreteWorklistPage } from './concrete/worklist/ConcreteWorklistPage';
import { HoldManagementPage } from './concrete/holds/HoldManagementPage';
import { InventoryRedirect, StorageUnitRedirect } from './inventory/redirects';
import { ShelfPage } from './inventory/ShelfPage';
import { StorageUnitDetailPage } from './inventory/StorageUnitDetailPage';
import { AppLayout } from './layout/AppLayout';
import { RecordingPersonLayout, RequireRecordingPerson } from './session/recording-person';
import { WHO_IS_WORKING_PATH } from './session/recording-person-store';
import { WhoIsWorkingPage } from './session/WhoIsWorkingPage';
import { AdminPage } from './settings/admin/AdminLayout';
import { DashboardPage } from './pages/DashboardPage';
import { MicrosoftCallbackPage } from './pages/MicrosoftCallbackPage';
import { SignInPage } from './pages/SignInPage';
import { LabelPrintPage } from './printing/LabelPrintPage';
import { ProjectLayout } from './projects/ProjectLayout';
import { ProjectOverviewTab } from './projects/ProjectOverviewTab';
import { ProjectProgramsTab } from './projects/ProjectProgramsTab';
import { ProjectUnitsTab } from './projects/ProjectUnitsTab';
import { ProjectsPage } from './projects/ProjectsPage';
import {
  ProjectConcreteMixesRedirect,
  ProjectConcreteRedirect,
  ProjectConcreteTab,
} from './concrete/project/ProjectConcretePage';
import { MixDetailPage } from './concrete/project/MixDetailPage';
import { PropagationReviewPage } from './concrete/project/PropagationReviewPage';
import { TeamPermissionsPage } from './projects/TeamPermissionsPage';
import {
  AccessPendingPage,
  ErrorPage,
  NotFoundPage,
  RequireActiveSession,
} from './pages/simple-pages';
import { HelpPage } from './pages/HelpPage';
import { PublicHelpGate } from './help/public-help';
import { ReceiveSamplesPage } from './receiving/ReceiveSamplesPage';
import { ReceiptDetailPage } from './receiving-log/ReceiptDetailPage';
import { ReceivingLogPage } from './receiving-log/ReceivingLogPage';
import { MovePage } from './moves/MovePage';
import { ScanPage } from './scanning/ScanPage';
import { TestSignInPage } from './TestSignInPage';
import { IssueReportPage } from './concrete-review/IssueReportPage';
import { ReviewQueuePage } from './concrete-review/ReviewQueuePage';
import { ReviewReportPage } from './concrete-review/ReviewReportPage';
import { StrengthReportPage } from './concrete-review/StrengthReportPage';
import { ConcreteDashboardPage } from './concrete/lab/ConcreteDashboardPage';
import { ConcreteReceivingPage } from './concrete/lab/ConcreteReceivingPage';
import { ConcreteSearchPage, SpecimenLookupPage } from './concrete/lab/ConcreteSearchPage';
import { SetLookupPage } from './concrete/lab/SetLookupPage';
import { SearchPage } from './search/SearchPage';
import { TestingTablePage } from './concrete/testing/TestingTablePage';

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
        // Concrete breaks (MM-V2-C22) and HOLD management (MM-V2-C26) keep their URLs under
        // /lab-testing but sit outside the Lab Testing layout: the rail's Concrete group replaces
        // the in-page section switch (Field Ledger, docs/redesign/design.md "Shell additions").
        { path: 'lab-testing/concrete', element: <ConcreteWorklistPage /> },
        { path: 'lab-testing/concrete/holds', element: <HoldManagementPage /> },
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
  ...(FEATURES.concreteReview
    ? [
        // MM-V2-C28: review queue, review view and issue view (field reports).
        { path: 'concrete/review', element: <ReviewQueuePage /> },
        { path: 'concrete/review/:reportId', element: <ReviewReportPage /> },
        { path: 'concrete/review/:reportId/issue', element: <IssueReportPage /> },
        // MM-V2-C39: a specimen set's strength report (lab submit, review, issue, revise).
        { path: 'concrete/strength/:setId', element: <StrengthReportPage /> },
      ]
    : []),
  ...(FEATURES.concreteLab
    ? [
        // MM-V2-C31: Concrete dashboard, Concrete Lab workspace, search and specimen lookup.
        { path: 'concrete', element: <ConcreteDashboardPage /> },
        { path: 'concrete/receiving', element: <ConcreteReceivingPage /> },
        { path: 'concrete/search', element: <ConcreteSearchPage /> },
        { path: 'concrete/specimens', element: <SpecimenLookupPage /> },
        { path: 'concrete/specimens/:setId', element: <SetLookupPage /> },
        // MM-V2-C23: the daily testing table (direct entry of today's breaks).
        { path: 'concrete/testing', element: <TestingTablePage /> },
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
      { path: '/access-pending', element: <AccessPendingPage /> },
      // Strata shared-component gallery (lane 1B): dev server only. DEV is a build-time constant,
      // so the production build drops this route and its chunk.
      ...(import.meta.env.DEV
        ? [
            {
              path: '/dev/strata',
              lazy: async () => ({
                Component: (await import('./components/strata/StrataGallery')).StrataGallery,
              }),
            },
          ]
        : []),
      {
        // /help also works without the app (STRATA-103): the gate shows the public guides to a
        // visitor who is signed out, waiting for approval, or on a LAB station before picking.
        element: (
          <PublicHelpGate>
            <RequireActiveSession />
          </PublicHelpGate>
        ),
        children: [
          {
            // One recording-person controller for the LAB station (STRATA-16, 61, 125), above
            // both the picker and the app so they share one state. Personal accounts pass through.
            element: <RecordingPersonLayout />,
            children: [
              { path: WHO_IS_WORKING_PATH, element: <WhoIsWorkingPage /> },
              {
                element: <RequireRecordingPerson />,
                children: [
                  // Label print views (MM-T39): no app chrome, one 3.5 x 1.5 in label per page.
                  { path: '/labels/print/unit/:id', element: <LabelPrintPage scope="unit" /> },
                  {
                    path: '/labels/print/receipt/:id',
                    element: <LabelPrintPage scope="receipt" />,
                  },
                  // Units chosen on Inventory (selection bar → Print labels): `?ids=` readable IDs.
                  { path: '/labels/print/units', element: <LabelPrintPage scope="units" /> },
                  // Sample ID tag sheets (MM-T69): no app chrome, letter sheets of ten 2 x 4 in cards.
                  ...(FEATURES.labTesting
                    ? [
                        {
                          path: '/lab-testing/programs/:programId/tags',
                          element: <SampleTagsPage />,
                        },
                      ]
                    : []),
                  {
                    path: '/',
                    element: <AppLayout />,
                    children: [
                      {
                        // A page that crashes shows "Something went wrong" inside the shell (STRATA-105).
                        errorElement: <ErrorPage inShell />,
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
                          // Field Ledger shelf page: where a scanned shelf (location) label lands.
                          { path: 'sample-storage/locations/:code', element: <ShelfPage /> },
                          {
                            path: 'sample-storage/:readableId',
                            element: <StorageUnitDetailPage />,
                          },
                          { path: 'inventory', element: <InventoryRedirect /> },
                          { path: 'storage-units/:suNumber', element: <StorageUnitRedirect /> },
                          // Action requests inbox (MM-T27): personal accounts; the header bell links here.
                          { path: 'action-requests', element: <ActionRequestsPage /> },
                          // Notification center (MM-T91): personal accounts; the header Notifications control
                          // links here. Separate from action requests; nothing here resolves one.
                          { path: 'notifications', element: <NotificationsPage /> },
                          // Help and how-tos (STRATA-103); signed out, PublicHelpGate shows it instead.
                          { path: 'help', element: <HelpPage /> },
                          // Field Ledger search across units, samples, projects and programs (top bar, Find).
                          { path: 'search', element: <SearchPage /> },
                          // Projects list (STRATA-83) and the project page with its tabs
                          // (STRATA-84): each tab keeps its own URL, Concrete included (STRATA-98).
                          { path: 'projects', element: <ProjectsPage /> },
                          {
                            path: 'projects/:projectId',
                            element: <ProjectLayout />,
                            children: [
                              { index: true, element: <ProjectOverviewTab /> },
                              { path: 'units', element: <ProjectUnitsTab /> },
                              { path: 'programs', element: <ProjectProgramsTab /> },
                              { path: 'team', element: <TeamPermissionsPage /> },
                              // The project's Concrete tab (MM-V2-C30, STRATA-98): five sub-tabs,
                              // each its own address; /concrete opens Field reports.
                              { path: 'concrete', element: <ProjectConcreteRedirect /> },
                              { path: 'concrete/:tab', element: <ProjectConcreteTab /> },
                            ],
                          },
                          // A mix and its change propagation (MM-V2-C30, STRATA-98): pages of their own
                          // with a breadcrumb back through the project.
                          {
                            path: 'projects/:projectId/concrete/mixes/:mixId',
                            element: <MixDetailPage />,
                          },
                          {
                            path: 'projects/:projectId/concrete/mixes/:mixId/propagation',
                            element: <PropagationReviewPage />,
                          },
                          // C37's former mixes screen: its actions are on the Concrete → Mixes tab now.
                          {
                            path: 'projects/:projectId/concrete-mixes',
                            element: <ProjectConcreteMixesRedirect />,
                          },
                          // Settings is a modal over the page you were on (STRATA-28, 100): the shell's
                          // SettingsOutlet keeps that page behind it. A fresh load of a /settings address
                          // shows Today behind the modal.
                          { path: 'settings', element: <DashboardPage /> },
                          { path: 'settings/*', element: <DashboardPage /> },
                          // Lab admin: Staff, Locations and Lab tests as full pages (STRATA-128).
                          { path: 'admin', element: <Navigate to="/admin/staff" replace /> },
                          { path: 'admin/staff', element: <AdminPage tab="staff" /> },
                          { path: 'admin/locations', element: <AdminPage tab="locations" /> },
                          { path: 'admin/lab-tests', element: <AdminPage tab="lab-tests" /> },
                          ...featureRoutes,
                          { path: '*', element: <NotFoundPage /> },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];
