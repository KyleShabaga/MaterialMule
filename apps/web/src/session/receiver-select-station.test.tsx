import type { MeResponse, ReceiverOption } from '@materialmule/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { SessionContext } from './context';
import { RecordingPersonLayout, useRecordingPerson } from './recording-person';
import { stationSessionKey, storeRecordingPerson } from './recording-person-store';

// STRATA-125: on a station, Moved by starts as the person in Recording as, and
// performers (Who is doing this?, Removed by, Printed by) are that person, read-only. Personal
// accounts are unchanged. Fictional people only.

const LAB: MeResponse = {
  id: 'lab',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
  status: 'active',
  roles: [],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-12-12T16:00:00.000Z',
};
const PERSONAL: MeResponse = {
  ...LAB,
  id: 'pat',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
};
const STAFF = [
  {
    id: 'p-alex',
    displayName: 'Alex Tester',
    initials: 'AT',
    position: 'technician',
    jobTitle: null,
  },
  {
    id: 'p-jordan',
    displayName: 'Jordan Lab',
    initials: 'JL',
    position: 'technologist',
    jobTitle: null,
  },
];
const ALEX = { id: 'p-alex', displayName: 'Alex Tester', initials: 'AT', roleLine: 'Technician' };
const JORDAN = {
  id: 'p-jordan',
  displayName: 'Jordan Lab',
  initials: 'JL',
  roleLine: 'Technologist',
};

let changes: (ReceiverOption | null)[] = [];

function Field({
  mode,
  initial = null,
}: {
  mode: 'prefill' | 'follow';
  initial?: ReceiverOption | null;
}) {
  const [value, setValue] = useState<ReceiverOption | null>(initial);
  const { pick } = useRecordingPerson();
  return (
    <>
      <ReceiverSelect
        label={mode === 'prefill' ? 'Moved by' : 'Who is doing this?'}
        stationPerson={mode}
        value={value}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
      />
      <output data-testid="value">{value?.displayName ?? 'none'}</output>
      <button type="button" onClick={() => pick(JORDAN)}>
        Switch to Jordan
      </button>
    </>
  );
}

function renderField(element: React.ReactNode, me: MeResponse = LAB) {
  const router = createMemoryRouter(
    [{ element: <RecordingPersonLayout />, children: [{ path: '/', element }] }],
    { initialEntries: ['/'] },
  );
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
}

beforeEach(() => {
  changes = [];
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/staff/active') return Response.json(STAFF);
      return Response.json([]);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReceiverSelect on a LAB station', () => {
  it('prefill: starts as the picked person, stays editable and follows a switch', async () => {
    const user = userEvent.setup();
    storeRecordingPerson(stationSessionKey(LAB), ALEX);
    renderField(<Field mode="prefill" />);
    const field = await screen.findByRole('combobox', { name: 'Moved by' });
    await waitFor(() => expect(field).toHaveValue('AT · Alex Tester'));
    expect(field).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Switch to Jordan' }));
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('Jordan Lab'));
  });

  it('prefill: keeps a receiver someone chose by hand when the person switches', async () => {
    const user = userEvent.setup();
    storeRecordingPerson(stationSessionKey(LAB), ALEX);
    renderField(
      <Field mode="prefill" initial={{ id: 'p-sam', initials: 'SS', displayName: 'Sam Sample' }} />,
    );
    expect(await screen.findByTestId('value')).toHaveTextContent('Sam Sample');
    await user.click(screen.getByRole('button', { name: 'Switch to Jordan' }));
    expect(screen.getByTestId('value')).toHaveTextContent('Sam Sample');
    expect(changes).toEqual([]);
  });

  it('follow: is the picked person, read-only, and follows the chip', async () => {
    const user = userEvent.setup();
    storeRecordingPerson(stationSessionKey(LAB), ALEX);
    renderField(<Field mode="follow" />);
    const field = await screen.findByRole('textbox', { name: 'Who is doing this?' });
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveValue('AT · Alex Tester');
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent('Alex Tester'));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch to Jordan' }));
    await waitFor(() => expect(field).toHaveValue('JL · Jordan Lab'));
    expect(screen.getByTestId('value')).toHaveTextContent('Jordan Lab');
  });

  it('is unchanged for a personal account', async () => {
    renderField(<Field mode="follow" />, PERSONAL);
    const field = await screen.findByRole('combobox', { name: 'Who is doing this?' });
    expect(field).toHaveValue('');
    expect(changes).toEqual([]);
  });

  it('is unchanged outside the provider', () => {
    render(
      <ReceiverSelect
        label="Moved by"
        stationPerson="prefill"
        value={null}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Moved by' })).toHaveValue('');
  });
});
