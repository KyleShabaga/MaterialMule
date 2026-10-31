import { healthResponseSchema } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { useTheme } from '../theme/theme';

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
      <span className="theme-switch-track" aria-hidden="true">
        <span className="theme-switch-thumb" />
      </span>
      <span className="theme-switch-state" aria-hidden="true">
        {dark ? 'On' : 'Off'}
      </span>
    </button>
  );
}

/** Bottom of the side menu (desktop sidebar and phone drawer). */
export function SidebarFooter() {
  return (
    <div className="side-nav-footer">
      <ThemeSwitch />
      <ServerHealth />
    </div>
  );
}
