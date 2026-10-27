import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionProvider } from './SessionProvider';

// MM-T61 review follow-up: a successful /api/me answer whose body isn't readable JSON (empty, an
// HTML page from a proxy, cut off mid-way) must end in the recoverable "unavailable" state with a
// Reload button, never an endless "Loading…". A 401 still goes to sign-in.

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubMe(response: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/me') return response();
      return new Response('{}', { status: 404 });
    }),
  );
}

function renderApp(path = '/') {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

/** A 200 whose body fails while being read, as when the connection drops mid-answer. */
function brokenBody() {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":'));
      controller.error(new TypeError('network error'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('SessionProvider with an unreadable successful /api/me answer', () => {
  it.each([
    ['an empty body', () => new Response('', { status: 200 })],
    [
      'malformed JSON',
      () =>
        new Response('{"id": "u1", ', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'an HTML page',
      () =>
        new Response('<!doctype html><title>Proxy</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    ],
    ['a body that fails mid-read', brokenBody],
  ])('shows the unavailable state with Reload for %s', async (_name, response) => {
    stubMe(response);
    renderApp('/sample-storage');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Material Mule is unavailable');
    expect(alert).toHaveTextContent('Reload the page to try again.');
    expect(alert).not.toHaveTextContent(/API|JSON|Unexpected/);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('still sends a 401 to sign-in', async () => {
    stubMe(() => new Response(JSON.stringify({ code: 'unauthenticated' }), { status: 401 }));
    const router = renderApp('/sample-storage');

    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toContain('returnTo=%2Fsample-storage');
    expect(screen.queryByRole('alert', { name: /unavailable/ })).not.toBeInTheDocument();
  });
});
