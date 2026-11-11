import { healthResponseSchema } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { PendingActionsLink } from '../action-requests/ActionRequestsBell';
import { StatusBadge } from '../components/ui';
import { formatExpiry } from '../lib/format';
import { useMe, useSession } from '../session/context';
import { useTheme } from '../theme/theme';
import { accountBadge, accountInitials, accountRoleLine, activeDestination } from './nav';

const HEALTH_POLL_MS = 60_000;

type Health = 'checking' | 'ok' | 'degraded' | 'unreachable';

const HEALTH_TEXT: Record<Health, string> = {
  checking: 'Checking server…',
  ok: 'Server connected',
  degraded: 'Server connected, database unavailable',
  unreachable: 'Server unreachable',
};

async function checkHealth(): Promise<Health> {
  try {
    const response = await fetch('/api/health', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const body = healthResponseSchema.safeParse(await response.json().catch(() => null));
    if (!body.success) return 'unreachable';
    return response.ok && body.data.status === 'ok' ? 'ok' : 'degraded';
  } catch {
    return 'unreachable';
  }
}

/** MISC-09: server health (GET /api/health), every minute and when the window regains focus. */
export function ServerHealth() {
  const [health, setHealth] = useState<Health>('checking');

  useEffect(() => {
    let active = true;
    const refresh = () =>
      void checkHealth().then((next) => {
        if (active) setHealth(next);
      });
    refresh();
    const timer = window.setInterval(refresh, HEALTH_POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return (
    // aria-live rather than role=status: pages keep their one status region for their own notices.
    <p className={`server-health server-health-${health}`} aria-live="polite">
      <span className="server-health-dot" aria-hidden="true" />
      {HEALTH_TEXT[health]}
    </p>
  );
}

/** MISC-09: dark mode switch. Text says the state too, not only the switch position. */
export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      className="theme-switch"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      <span className="theme-switch-label">Dark mode</span>
      <span className="theme-switch-state" aria-hidden="true">
        {dark ? 'On' : 'Off'}
      </span>
      <span className="theme-switch-track" aria-hidden="true">
        <span className="theme-switch-thumb" />
      </span>
    </button>
  );
}

function GearIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22M4.9 4.9l2.5 2.5M16.6 16.6l2.5 2.5M4.9 19.1l2.5-2.5M16.6 7.4l2.5-2.5" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 4H5v16h5" />
      <path d="M14 8l4 4-4 4" />
      <path d="M18 12H9" />
    </svg>
  );
}

/**
 * The account row: initials square, name, role line and the sign-out icon button. The shared LAB
 * station also gets Switch user and its session end; TEST and LAB accounts keep their tag.
 */
export function AccountRow() {
  const me = useMe();
  const { signOut } = useSession();
  const badge = accountBadge(me);
  const lab = me.accountType === 'shared_lab';
  return (
    <div className="account" role="group" aria-label="Signed in user">
      <div className="account-row">
        <span className="account-initials" aria-hidden="true">
          {accountInitials(me)}
        </span>
        <span className="account-text">
          <span className="account-name">{me.displayName}</span>
          <span className="account-role">{accountRoleLine(me)}</span>
        </span>
        <button
          type="button"
          className="account-sign-out"
          aria-label="Sign out"
          title="Sign out"
          onClick={() => void signOut()}
        >
          <SignOutIcon />
        </button>
      </div>
      {me.accountType !== 'personal' ? (
        <span className="account-tag">
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        </span>
      ) : null}
      {lab ? (
        <>
          <p className="account-expiry">
            Session ends{' '}
            <time dateTime={me.sessionExpiresAt}>{formatExpiry(me.sessionExpiresAt)}</time>
          </p>
          <button
            type="button"
            className="account-switch"
            onClick={() => void signOut('/sign-in?switch=1')}
          >
            Switch user
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * Bottom of the rail (and of the phone More sheet): Pending actions (personal accounts), Settings
 * and Help & Feedback, then a 2 px rule and the account row, then the dark mode switch and server
 * health (MISC-09).
 */
export function SidebarFooter({ onNavigate }: { onNavigate?: () => void } = {}) {
  const me = useMe();
  const { pathname } = useLocation();
  const settings = activeDestination(pathname) === 'settings';
  const help = pathname === '/help' || pathname.startsWith('/help/');
  return (
    <div className="rail-footer">
      <ul className="rail-footer-links">
        {me.permissions.includes('action_item.read') ? (
          <li>
            <PendingActionsLink onNavigate={onNavigate} />
          </li>
        ) : null}
        <li>
          <Link
            to="/settings"
            className="rail-link rail-footer-link"
            aria-current={settings ? 'page' : undefined}
            onClick={onNavigate}
          >
            <GearIcon />
            <span>Settings</span>
          </Link>
        </li>
        <li>
          <Link
            to="/help"
            className="rail-link rail-footer-link"
            aria-current={help ? 'page' : undefined}
            onClick={onNavigate}
          >
            <HelpIcon />
            <span>Help &amp; Feedback</span>
          </Link>
        </li>
      </ul>
      <AccountRow />
      <ThemeSwitch />
      <ServerHealth />
    </div>
  );
}
