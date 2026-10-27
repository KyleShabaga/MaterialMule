import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSession } from './context';

// MM-T61: page-load messages name Material Mule and say what to do, never "API".

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadSession messages', () => {
  it('says Material Mule couldn’t be reached when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(await loadSession()).toEqual({
      status: 'error',
      message: 'Material Mule couldn’t be reached. Check the connection, then reload the page.',
    });
  });

  it('asks for a reload when the answer can’t be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ unexpected: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const state = await loadSession();
    expect(state).toMatchObject({ status: 'error' });
    expect(state.status === 'error' ? state.message : '').not.toMatch(/API/);
  });
});
