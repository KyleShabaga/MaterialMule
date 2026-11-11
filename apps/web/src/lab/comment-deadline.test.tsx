import type { LabComment, MeResponse } from '@materialmule/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../session/context';
import { CommentItem } from './WorkedProgram';

// MTR-139: the 15-minute edit window is shown as text and closes on its own.

const me: MeResponse = {
  id: 'u-at',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['lab_comment.write'],
  sessionExpiresAt: '2026-10-30T16:00:00.000Z',
  profileRefreshFailed: false,
};

// 9:49 p.m. on Oct 29 in America/Edmonton (MDT, UTC-6); editable until 10:04 p.m.
const comment: LabComment = {
  id: 'c-1',
  lineId: null,
  account: { userId: 'u-at', initials: 'AT', name: 'Alex Tester', accountType: 'personal' },
  author: { userId: 'u-at', initials: 'AT', name: 'Alex Tester' },
  body: 'Lane E comment (fictional)',
  createdAt: '2026-10-30T03:49:00.000Z',
  editedAt: null,
  editableUntil: '2026-10-30T04:04:00.000Z',
  version: 1,
  revisions: [],
};

function renderComment(item: LabComment = comment) {
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <ul>
        <CommentItem comment={item} onChanged={vi.fn()} />
      </ul>
    </SessionContext.Provider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Records PATCH /api/comments/... calls and answers them with the edited comment. */
function stubEditApi() {
  const edits: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/comments/') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { body: string };
        edits.push(body);
        return new Response(JSON.stringify({ ...comment, body: body.body, version: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  return edits;
}

describe('Lab comment edit deadline (MTR-139)', () => {
  it('shows "Editable until" beside Edit, and both go away when the window closes', () => {
    vi.useFakeTimers({ now: new Date('2026-10-30T03:50:00.000Z') });
    renderComment();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByText(/^Editable until 10:04/)).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(13 * 60_000));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(60_000 + 1));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Editable until/)).not.toBeInTheDocument();
  });

  it('shows no deadline once the window has passed', () => {
    vi.useFakeTimers({ now: new Date('2026-10-30T04:05:00.000Z') });
    renderComment();
    expect(screen.queryByText(/Editable until/)).not.toBeInTheDocument();
  });

  it('shows no deadline on another person’s comment', () => {
    vi.useFakeTimers({ now: new Date('2026-10-30T03:50:00.000Z') });
    renderComment({
      ...comment,
      account: { ...comment.account, userId: 'u-other' },
    });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Editable until/)).not.toBeInTheDocument();
  });

  it('saves from an open editor before the deadline', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-30T04:03:00.000Z') });
    const edits = stubEditApi();
    renderComment();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit comment'), { target: { value: 'Fixed text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save comment' }));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(edits).toHaveLength(1);
  });

  it('announces expiry in an open editor, keeps the draft and sends nothing', async () => {
    // One second before 10:04 p.m.
    vi.useFakeTimers({ now: new Date('2026-10-30T04:03:59.000Z') });
    const edits = stubEditApi();
    renderComment();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit comment');
    fireEvent.change(box, { target: { value: 'Late change' } });
    expect(screen.getByRole('button', { name: 'Save comment' })).toBeEnabled();

    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('alert')).toHaveTextContent(/edit window has closed/);
    expect(screen.getByLabelText('Edit comment')).toHaveValue('Late change');
    const save = screen.getByRole('button', { name: 'Save comment' });
    expect(save).toBeDisabled();

    fireEvent.click(save);
    // A direct form submit (Enter in a field) must not send either.
    fireEvent.submit(box.closest('form')!);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(edits).toHaveLength(0);
  });

  it('refuses a keyboard submit even if the deadline passed before the timer fired', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-30T04:03:59.000Z') });
    const edits = stubEditApi();
    renderComment();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit comment');
    // Move the clock without running timers, like a throttled background tab.
    vi.setSystemTime(new Date('2026-10-30T04:04:01.000Z'));
    fireEvent.submit(box.closest('form')!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(edits).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent(/edit window has closed/);
  });
});
