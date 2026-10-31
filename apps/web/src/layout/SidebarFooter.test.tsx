import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from '../theme/theme';
import { ServerHealth, ThemeSwitch } from './SidebarFooter';

// MISC-09: sidebar footer — dark mode switch and server health in words, not colour alone.

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
});

describe('ThemeSwitch', () => {
  it('is a labelled switch that flips the theme and remembers it', async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);
    const toggle = screen.getByRole('switch', { name: 'Dark mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('ServerHealth', () => {
  it('says the server is connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { status: 'ok', version: '0.1.0', database: 'up' })),
    );
    render(<ServerHealth />);
    expect(screen.getByText('Checking server…')).toHaveAttribute('aria-live', 'polite');
    expect(await screen.findByText('Server connected')).toBeInTheDocument();
  });

  it('says when the database is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(503, { status: 'degraded', version: '0.1.0', database: 'down' })),
    );
    render(<ServerHealth />);
    expect(await screen.findByText('Server connected, database unavailable')).toBeInTheDocument();
  });

  it('says when the server is unreachable, and re-checks on window focus', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ServerHealth />);
    expect(await screen.findByText('Server unreachable')).toBeInTheDocument();
    fetchMock.mockImplementation(async () =>
      json(200, { status: 'ok', version: '0.1.0', database: 'up' }),
    );
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByText('Server connected')).toBeInTheDocument();
  });
});
