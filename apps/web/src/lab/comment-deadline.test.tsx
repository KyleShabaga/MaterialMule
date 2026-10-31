import type { LabComment, MeResponse } from '@materialmule/shared';
import { act, render, screen } from '@testing-library/react';
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

afterEach(() => vi.useRealTimers());

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
});
