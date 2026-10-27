import type { ReceiverOption } from '@materialmule/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOT_LISTED_MESSAGE, ReceiverSelect } from './ReceiverSelect';

const JORDAN: ReceiverOption = {
  id: 'id-jordan',
  initials: 'JS',
  displayName: 'Jordan Smith',
  position: 'technician',
};
const ALEX: ReceiverOption = {
  id: 'id-alex',
  initials: 'AT',
  displayName: 'Alex Tester',
  position: 'technician',
};
const JAMIE: ReceiverOption = {
  id: 'id-jamie',
  initials: 'JS',
  displayName: 'Jamie Song',
  position: 'engineer',
};

function stubReceivers(byQuery: Record<string, ReceiverOption[]>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const search = (url.searchParams.get('search') ?? '').toLowerCase();
    return new Response(JSON.stringify(byQuery[search] ?? []), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Harness({
  onChange,
  initial = null,
}: {
  onChange: (value: ReceiverOption | null) => void;
  initial?: ReceiverOption | null;
}) {
  const [value, setValue] = useState<ReceiverOption | null>(initial);
  return (
    <ReceiverSelect
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReceiverSelect', () => {
  it('MM-T53 AC1: clicking into a chosen receiver and typing starts a new search', async () => {
    stubReceivers({ at: [ALEX] });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} initial={JORDAN} />);

    const input = screen.getByRole('combobox', { name: /Received by/ });
    expect(input).toHaveValue('JS · Jordan Smith (Tech)');
    await user.click(input);
    await user.keyboard('AT');
    expect(input).toHaveValue('AT');
    expect(onChange).toHaveBeenCalledWith(null);
    expect(await screen.findByRole('option', { name: 'AT · Alex Tester (Tech)' })).toBeVisible();
  });

  it('MM-T53 AC1: tabbing into a chosen receiver selects it too', async () => {
    stubReceivers({ at: [ALEX] });
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before</button>
        <Harness onChange={vi.fn()} initial={JORDAN} />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Before' }));
    await user.tab();
    await user.keyboard('AT');
    expect(screen.getByRole('combobox', { name: /Received by/ })).toHaveValue('AT');
  });

  it('MM-T53 AC2: focusing and leaving without typing keeps the receiver', async () => {
    const fetchMock = stubReceivers({});
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} initial={JORDAN} />);

    const input = screen.getByRole('combobox', { name: /Received by/ });
    await user.click(input);
    await user.tab();
    expect(input).toHaveValue('JS · Jordan Smith (Tech)');
    expect(onChange).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Choose a person from the list.')).toBeNull();
  });

  it('starts empty and does not search until something is typed', () => {
    const fetchMock = stubReceivers({});
    render(<Harness onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: /Received by/ })).toHaveValue('');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(NOT_LISTED_MESSAGE.replace('?', '\\?')))).toBeVisible();
  });

  it('AC3: "JS" lists both people with full names; the keyboard picks one by ID', async () => {
    stubReceivers({ js: [JAMIE, JORDAN] });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    const input = screen.getByRole('combobox', { name: /Received by/ });
    await user.type(input, 'JS');
    expect(await screen.findByRole('option', { name: 'JS · Jamie Song (Eng)' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'JS · Jordan Smith (Tech)' })).toBeVisible();
    expect(input).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(JORDAN);
    expect(input).toHaveValue('JS · Jordan Smith (Tech)');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('never keeps free text: typing after a choice clears it', async () => {
    stubReceivers({ js: [JORDAN] });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: /Received by/ });
    await user.type(input, 'js');
    await user.click(await screen.findByRole('option', { name: 'JS · Jordan Smith (Tech)' }));
    expect(onChange).toHaveBeenLastCalledWith(JORDAN);

    await user.type(input, 'X');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('explains what to do when nobody matches', async () => {
    stubReceivers({});
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: /Received by/ });
    await user.type(input, 'ZZ');
    expect(await screen.findByText('No active staff match.')).toBeVisible();
    await user.tab();
    expect(screen.getByText('Choose a person from the list.')).toBeVisible();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});
