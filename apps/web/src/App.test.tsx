import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { fetchHealth } from './api/health';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchHealth', () => {
  it('maps a 200 response to ok', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: 'ok', version: '0.1.0', database: 'up' }),
    );
    await expect(fetchHealth(fetchImpl)).resolves.toMatchObject({ kind: 'ok' });
  });

  it('maps a 503 health body to degraded', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(503, { status: 'degraded', version: '0.1.0', database: 'down' }),
    );
    await expect(fetchHealth(fetchImpl)).resolves.toMatchObject({ kind: 'degraded' });
  });

  it('maps a network failure to unavailable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchHealth(fetchImpl)).resolves.toMatchObject({ kind: 'unavailable' });
  });

  it('maps an unexpected body to unavailable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { hello: 'world' }));
    await expect(fetchHealth(fetchImpl)).resolves.toMatchObject({ kind: 'unavailable' });
  });
});

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the API status and version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { status: 'ok', version: '0.1.0', database: 'up' })),
    );
    render(<App />);
    expect(await screen.findByText('OK')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
  });

  it('shows an error state instead of a blank page when the API is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('API unavailable');
  });
});
