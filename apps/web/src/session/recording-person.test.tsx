import type { MeResponse, StaffOption } from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from './context';
import {
  RecordingAsChip,
  RecordingPersonLayout,
  RequireRecordingPerson,
  useRecordingPerson,
  type RecordingPerson,
} from './recording-person';
import {
  PERSON_SCOPED_PREFIX,
  RECORDING_PERSON_KEY,
  SIGN_OFF_UNDO_MS,
  WHO_IS_WORKING_PATH,
  stationSessionKey,
  storeRecordingPerson,
} from './recording-person-store';
import { WhoIsWorkingPage } from './WhoIsWorkingPage';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

// Fictional people only (DEMO fixtures' names).
const LAB: MeResponse = {
  id: 'lab',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
  status: 'active',
  roles: [],
  permissions: ['receipt.confirm', 'inventory.read'],
  sessionExpiresAt: '2026-12-12T16:00:00.000Z',
};
const PERSONAL: MeResponse = {
  ...LAB,
  id: 'alex',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
};

const STAFF: StaffOption[] = [
  {
    id: 'p-alex',
    displayName: 'Alex Tester',
    initials: 'AT',
    position: 'technician',
    jobTitle: null,
  },
  {
    id: 'p-dana',
    displayName: 'Dana Example',
    initials: 'DE',
    position: 'engineer',
    jobTitle: null,
  },
  {
    id: 'p-jordan',
    displayName: 'Jordan Lab',
    initials: 'JL',
    position: 'technologist',
    jobTitle: null,
  },
  {
    id: 'p-sam',
    displayName: 'Sam Sample',
    initials: 'SS',
    position: 'lab_manager',
    jobTitle: null,
  },
  { id: 'p-pat', displayName: 'Pat Example', initials: 'PE', position: 'engineer', jobTitle: null },
];
const ALEX: RecordingPerson = {
  id: 'p-alex',
  displayName: 'Alex Tester',
  initials: 'AT',
  roleLine: 'Technician',
};

function Probe() {
  const { isStation, person } = useRecordingPerson();
  return (
    <div>
      <RecordingAsChip />
      <p data-testid="probe">{`${isStation ? 'station' : 'personal'}:${person?.displayName ?? 'none'}`}</p>
    </div>
  );
}

const ROUTES: RouteObject[] = [
  {
    element: <RecordingPersonLayout />,
    children: [
      { path: WHO_IS_WORKING_PATH, element: <WhoIsWorkingPage /> },
      { path: '/help', element: <p>Help page</p> },
      {
        element: <RequireRecordingPerson />,
        children: [
          { path: '/', element: <Probe /> },
          { path: '/receiving-log/new', element: <Probe /> },
        ],
      },
    ],
  },
];

let staff: StaffOption[] | 'fail' = STAFF;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/staff/active') {
        if (staff === 'fail') return new Response('{}', { status: 500 });
        return Response.json(staff);
      }
      if (url.pathname === '/api/staff/receivers') {
        const q = (url.searchParams.get('search') ?? '').toLowerCase();
        return Response.json(
          [{ id: 'p-pat', initials: 'PE', displayName: 'Pat Example' }].filter((option) =>
            option.displayName.toLowerCase().includes(q),
          ),
        );
      }
      return new Response('{}', { status: 404 });
    }),
  );
}

function renderAt(path: string, me: MeResponse = LAB) {
  const signOut = vi.fn(async () => undefined);
  const router = createMemoryRouter(ROUTES, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{ session: { status: 'active', me }, refresh: vi.fn(async () => undefined), signOut }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return { router, signOut };
}

beforeEach(() => {
  staff = STAFF;
  stubFetch();
  toastMock.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RecordingPersonProvider and RequireRecordingPerson', () => {
  it('lets a personal account straight through, with no chip', async () => {
    renderAt('/receiving-log/new', PERSONAL);
    expect(await screen.findByTestId('probe')).toHaveTextContent('personal:none');
    expect(screen.queryByRole('button', { name: /Recording as/ })).not.toBeInTheDocument();
  });

  it('sends a station with no one picked to Who is working here?, then back where it was going', async () => {
    const user = userEvent.setup();
    const { router } = renderAt('/receiving-log/new');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Who is working here?' }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Alex Tester/ }));
    expect(await screen.findByTestId('probe')).toHaveTextContent('station:Alex Tester');
    expect(router.state.location.pathname).toBe('/receiving-log/new');
    // Remembered for this tab and this LAB session only.
    const stored = JSON.parse(window.sessionStorage.getItem(RECORDING_PERSON_KEY) ?? '{}');
    expect(stored).toMatchObject({ session: stationSessionKey(LAB), person: { id: 'p-alex' } });
  });

  it('keeps the picked person across a reload of the same LAB session', async () => {
    storeRecordingPerson(stationSessionKey(LAB), ALEX);
    renderAt('/');
    expect(await screen.findByTestId('probe')).toHaveTextContent('station:Alex Tester');
  });

  it('ignores a pick left by an earlier LAB session', async () => {
    storeRecordingPerson(
      stationSessionKey({ ...LAB, sessionExpiresAt: '2026-10-01T00:00:00Z' }),
      ALEX,
    );
    renderAt('/');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Who is working here?' }),
    ).toBeInTheDocument();
  });

  it('drops a remembered person who is no longer active staff and says why', async () => {
    storeRecordingPerson(stationSessionKey(LAB), {
      ...ALEX,
      id: 'p-gone',
      displayName: 'Riley Gone',
    });
    renderAt('/');
    expect(
      await screen.findByText(
        'Riley Gone can’t be recorded as any more. Choose who is working here.',
      ),
    ).toBeInTheDocument();
    expect(window.sessionStorage.getItem(RECORDING_PERSON_KEY)).toBeNull();
  });

  it('signs off: back to the picker, private view state cleared, Undo for 8 seconds restores', async () => {
    const user = userEvent.setup();
    storeRecordingPerson(stationSessionKey(LAB), ALEX);
    window.sessionStorage.setItem(`${PERSON_SCOPED_PREFIX}inbox-filter`, 'mine');
    window.localStorage.setItem(`${PERSON_SCOPED_PREFIX}recent`, 'x');
    window.localStorage.setItem('materialmule.theme', 'dark');
    const { router } = renderAt('/receiving-log/new');

    await user.click(
      await screen.findByRole('button', {
        name: 'Recording as Alex Tester. Sign off or switch person',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /Sign off Alex Tester/ }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Who is working here?' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(RECORDING_PERSON_KEY)).toBeNull());
    expect(window.sessionStorage.getItem(`${PERSON_SCOPED_PREFIX}inbox-filter`)).toBeNull();
    expect(window.localStorage.getItem(`${PERSON_SCOPED_PREFIX}recent`)).toBeNull();
    expect(window.localStorage.getItem('materialmule.theme')).toBe('dark');

    expect(toastMock).toHaveBeenCalledWith('Signed off Alex Tester', {
      description: 'Back to Who is working here? Nothing was recorded by signing off.',
      duration: SIGN_OFF_UNDO_MS,
      action: { label: 'Undo', onClick: expect.any(Function) },
    });
    expect(SIGN_OFF_UNDO_MS).toBe(8000);

    const undo = toastMock.mock.calls[0]![1].action.onClick as () => void;
    act(() => undo());
    expect(await screen.findByTestId('probe')).toHaveTextContent('station:Alex Tester');
    expect(router.state.location.pathname).toBe('/receiving-log/new');
  });

  it('after a sign-off the next person starts on Today', async () => {
    const user = userEvent.setup();
    storeRecordingPerson(stationSessionKey(LAB), ALEX);
    const { router } = renderAt('/receiving-log/new');
    await user.click(await screen.findByRole('button', { name: /^Recording as Alex Tester/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Sign off Alex Tester/ }));
    await user.click(await screen.findByRole('button', { name: /Sam Sample/ }));
    expect(await screen.findByTestId('probe')).toHaveTextContent('station:Sam Sample');
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('RecordingAsChip', () => {
  it('shows who is recording and a menu: label, Sign off first, then Switch person, then Someone else…', async () => {
    const user = userEvent.setup();
    storeRecordingPerson(stationSessionKey(LAB), ALEX);
    renderAt('/');
    const chip = await screen.findByRole('button', {
      name: 'Recording as Alex Tester. Sign off or switch person',
    });
    expect(chip).toHaveTextContent('Recording as Alex Tester');
    await user.click(chip);
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu).getAllByRole('menuitemradio').length).toBe(3));
    const items = Array.from(menu.querySelectorAll('[role^="menuitem"]')).map(
      (item) => item.textContent,
    );
    expect(menu).toHaveTextContent(/^Recording as Alex Tester/);
    expect(items).toEqual([
      'Sign off Alex TesterBack to Who is working here?',
      'ATAlex TesterTechnician',
      'JLJordan LabTechnologist',
      'SSSam SampleLab Manager',
      'Someone else…',
    ]);
    expect(within(menu).getByRole('menuitemradio', { name: /Alex Tester/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('switches person from the menu without leaving the page', async () => {
    const user = userEvent.setup();
    storeRecordingPerson(stationSessionKey(LAB), ALEX);
    const { router } = renderAt('/receiving-log/new');
    await user.click(await screen.findByRole('button', { name: /^Recording as Alex Tester/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Jordan Lab/ }));
    expect(await screen.findByTestId('probe')).toHaveTextContent('station:Jordan Lab');
    expect(router.state.location.pathname).toBe('/receiving-log/new');
  });

  it('Someone else… opens the picker search and comes back to the page', async () => {
    const user = userEvent.setup();
    storeRecordingPerson(stationSessionKey(LAB), ALEX);
    const { router } = renderAt('/receiving-log/new');
    await user.click(await screen.findByRole('button', { name: /^Recording as Alex Tester/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Someone else…' }));
    await user.type(await screen.findByRole('searchbox', { name: 'Find a person' }), 'Pat');
    await user.click(await screen.findByRole('button', { name: /Pat Example/ }));
    expect(await screen.findByTestId('probe')).toHaveTextContent('station:Pat Example');
    expect(router.state.location.pathname).toBe('/receiving-log/new');
  });
});

describe('WhoIsWorkingPage', () => {
  it('lists the station’s lab staff with name and role, then Someone else…, the help link and LAB sign-out', async () => {
    const user = userEvent.setup();
    const { signOut } = renderAt(WHO_IS_WORKING_PATH);
    expect(
      screen.getByText(
        'Signed in as LAB. Receipts, moves and labels are recorded under the name you pick, until you sign off.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How LAB stations work' })).toHaveAttribute(
      'href',
      '/help#lab-stations',
    );
    const list = await screen.findByRole('list', { name: 'Receiving lab staff' });
    const rows = within(list)
      .getAllByRole('button')
      .map((row) => row.textContent);
    // Engineers are not station people; they're found with Someone else….
    expect(rows).toEqual([
      'ATAlex TesterTechnician',
      'JLJordan LabTechnologist',
      'SSSam SampleLab Manager',
      'Someone else…',
    ]);
    await user.click(screen.getByRole('button', { name: 'Sign out of LAB' }));
    expect(signOut).toHaveBeenCalled();
  });

  it('shows the empty state with Someone else… when no one is listed', async () => {
    const user = userEvent.setup();
    staff = [STAFF[1]!];
    renderAt(WHO_IS_WORKING_PATH);
    expect(await screen.findByText('No one is listed for this station yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Someone else…' }));
    const search = await screen.findByRole('searchbox', { name: 'Find a person' });
    await user.type(search, 'zzz');
    expect(
      await screen.findByText('No active staff match. Ask an administrator to add them.'),
    ).toBeInTheDocument();
  });

  it('offers Try again and Someone else… when the list can’t load', async () => {
    staff = 'fail';
    renderAt(WHO_IS_WORKING_PATH);
    expect(await screen.findByText(/The station’s people couldn’t load/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Someone else…' })).toBeInTheDocument();
  });

  it('sends a personal account home', async () => {
    renderAt(WHO_IS_WORKING_PATH, PERSONAL);
    expect(await screen.findByTestId('probe')).toHaveTextContent('personal:none');
  });
});
