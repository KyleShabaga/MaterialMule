import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOptionalFeedbackDialog } from './feedback-context';
import { FeedbackDialogProvider } from './FeedbackDialog';

// Feedback & bugs (STRATA-104): a dialog over the page; success only after the server answers.
// Fictional text only.

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function Opener() {
  const feedback = useOptionalFeedbackDialog()!;
  return (
    <button type="button" onClick={() => feedback.open()}>
      Open feedback
    </button>
  );
}

function renderDialog(path = '/sample-storage/move?search=DEMO-2601#x') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <FeedbackDialogProvider>
        <Opener />
      </FeedbackDialogProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Feedback & bugs dialog', () => {
  it('validates, sends kind, text and the path only, and says Sent after the answer', async () => {
    let answer!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Open feedback' }));
    const dialog = await screen.findByRole('dialog', { name: 'Feedback & bugs' });
    expect(dialog).toHaveTextContent(
      'Stays inside the office. Nothing is sent outside the building.',
    );
    // Problem is chosen by default; the page is on by default and shows the path only.
    expect(within(dialog).getByRole('radio', { name: 'Problem' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const include = within(dialog).getByRole('checkbox', { name: 'Include the page I was on' });
    expect(include).toBeChecked();
    expect(dialog).toHaveTextContent('/sample-storage/move');
    expect(dialog).not.toHaveTextContent('DEMO-2601');

    // Nothing written: not sent, the message says why and focus goes to the field.
    await user.click(within(dialog).getByRole('button', { name: 'Send to the administrator' }));
    expect(
      within(dialog).getByText('Write a few words about what happened first.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('What happened')).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('radio', { name: 'Question' }));
    await user.type(within(dialog).getByLabelText('What happened'), 'Where do core boxes go?');
    const send = within(dialog).getByRole('button', { name: 'Send to the administrator' });
    await user.click(send);
    // Sending: one request, the button is busy, and a second click sends nothing more.
    expect(await within(dialog).findByRole('button', { name: /Sending/ })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: /Sending/ }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Sent.')).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/feedback');
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'confusing',
      text: 'Where do core boxes go?',
      page: '/sample-storage/move',
    });

    answer(json(201, { id: 'f1' }));
    expect(await screen.findByRole('heading', { name: 'Sent.' })).toBeInTheDocument();
    expect(
      screen.getByText('An administrator will read it here in the office.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Focus goes back to what opened it.
    expect(screen.getByRole('button', { name: 'Open feedback' })).toHaveFocus();
  });

  it('maps Problem and Idea to the API kinds and leaves the page out when unticked', async () => {
    const fetchMock = vi.fn(async () => json(201, { id: 'f2' }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderDialog('/projects');
    await user.click(screen.getByRole('button', { name: 'Open feedback' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Idea' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Include the page I was on' }));
    await user.type(within(dialog).getByLabelText('What happened'), 'Sort by due date');
    await user.click(within(dialog).getByRole('button', { name: 'Send to the administrator' }));
    await screen.findByRole('heading', { name: 'Sent.' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'idea', text: 'Sort by due date' });
  });

  it('asks for a kind when none is chosen', async () => {
    const fetchMock = vi.fn(async () => json(201, { id: 'f3' }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderDialog('/');
    await user.click(screen.getByRole('button', { name: 'Open feedback' }));
    const dialog = await screen.findByRole('dialog');
    // Clicking the chosen kind again clears it (a single toggle group).
    await user.click(within(dialog).getByRole('radio', { name: 'Problem' }));
    await user.type(within(dialog).getByLabelText('What happened'), 'Something');
    await user.click(within(dialog).getByRole('button', { name: 'Send to the administrator' }));
    expect(within(dialog).getByText('Choose what kind.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the text with a plain error when sending fails, and never shows Sent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(500, { message: 'stack at line 42' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(200, { unexpected: true }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderDialog('/');
    await user.click(screen.getByRole('button', { name: 'Open feedback' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('What happened'), 'The printer is offline');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await user.click(within(dialog).getByRole('button', { name: 'Send to the administrator' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('It couldn’t be sent.');
      expect(within(dialog).getByLabelText('What happened')).toHaveValue('The printer is offline');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Sent.')).toBeNull();
    expect(document.body.textContent).not.toContain('line 42');
  });

  it('closes with Esc and starts fresh the next time', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const user = userEvent.setup();
    renderDialog('/');
    await user.click(screen.getByRole('button', { name: 'Open feedback' }));
    await user.type(screen.getByLabelText('What happened'), 'Half a thought');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open feedback' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Open feedback' }));
    expect(await screen.findByLabelText('What happened')).toHaveValue('');
  });
});
