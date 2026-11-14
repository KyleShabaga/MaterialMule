import { Navigate, useLocation } from 'react-router';
import { INBOX_PATH } from './inbox-model';

/**
 * The old Notifications (`/notifications`) and Action requests (`/action-requests`) pages are the
 * Inbox now (STRATA-24). Action requests opens the Requests tab. An old `?id=<id>` deep link opens
 * that item in the Inbox (`?open=update:<id>` or `?open=request:<id>`); other parameters are
 * dropped, since the old filters don't exist any more.
 */
export function InboxRedirect({ from }: { from: 'notifications' | 'action-requests' }) {
  const { search } = useLocation();
  const old = new URLSearchParams(search);
  const next = new URLSearchParams();
  if (from === 'action-requests') next.set('tab', 'requests');
  const id = old.get('id');
  if (id) next.set('open', `${from === 'action-requests' ? 'request' : 'update'}:${id}`);
  const query = next.toString();
  return <Navigate to={query ? `${INBOX_PATH}?${query}` : INBOX_PATH} replace />;
}
