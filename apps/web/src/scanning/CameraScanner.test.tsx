import type { MeResponse } from '@trapezoid/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { CameraScanner, type CameraDevices } from './CameraScanner';
import type { BarcodeDecoder, DecodedSymbol } from './decoder';

// TRP-T17 with a fake camera: a fake MediaStream, a fake decoder and a frame reader that always
// has a frame. Real decoding of generated label images is covered by e2e/camera-scan.spec.ts.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const KNOWN: Record<string, string> = {
  'BKT-2026-000014': '00000000-0000-4000-8000-000000000501',
};

function stubApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/storage-units/lookup') {
      const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
      return KNOWN[code]
        ? json(200, { id: KNOWN[code], readableId: code })
        : json(404, { code: 'storage_unit_not_found' });
    }
    if (url.pathname === '/api/health') return json(200, { status: 'ok' });
    if (url.pathname === '/api/inventory')
      return json(200, { items: [], total: 0, page: 1, pageSize: 25 });
    if (url.pathname === '/api/locations') return json(200, []);
    return json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const lookupCount = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes('/storage-units/lookup')).length;

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
  readyState: 'live' | 'ended';
  getCapabilities: () => { torch?: boolean };
  getSettings: () => { deviceId: string };
  applyConstraints: ReturnType<typeof vi.fn>;
}

function fakeCamera(options: { cameras?: string[]; torch?: boolean; fail?: string } = {}) {
  const cameras = options.cameras ?? ['rear'];
  const tracks: FakeTrack[] = [];
  const getUserMedia = vi.fn(async (constraints?: MediaStreamConstraints) => {
    if (options.fail) throw new DOMException('fake', options.fail);
    const video = constraints?.video as { deviceId?: { exact: string } } | undefined;
    const deviceId = video?.deviceId?.exact ?? cameras[0]!;
    const track: FakeTrack = {
      readyState: 'live',
      stop: vi.fn(() => {
        track.readyState = 'ended';
      }),
      getCapabilities: () => (options.torch ? { torch: true } : {}),
      getSettings: () => ({ deviceId }),
      applyConstraints: vi.fn(async () => undefined),
    };
    tracks.push(track);
    return {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
  });
  const devices: CameraDevices = {
    getUserMedia,
    enumerateDevices: async () =>
      cameras.map((deviceId) => ({ kind: 'videoinput', deviceId }) as MediaDeviceInfo),
  };
  return {
    devices,
    getUserMedia,
    tracks,
    live: () => tracks.filter((t) => t.readyState === 'live'),
  };
}

/** A decoder that "sees" whatever `scene.codes` holds in every frame. */
function fakeDecoder() {
  const scene: { codes: DecodedSymbol[] } = { codes: [] };
  const decoder: BarcodeDecoder = { name: 'zxing', decode: vi.fn(async () => scene.codes) };
  return { scene, factory: vi.fn(async () => decoder), decoder };
}

const frame = () => ({}) as ImageData;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CameraScanner (TRP-T17)', () => {
  it('AC3: a label held in view opens the unit once, after "Found …"', async () => {
    const fetchMock = stubApi();
    const camera = fakeCamera();
    const { scene, factory } = fakeDecoder();
    const onFound = vi.fn();
    render(
      <CameraScanner
        onClose={vi.fn()}
        onFound={onFound}
        devices={camera.devices}
        secureContext
        decoderFactory={factory}
        readFrame={frame}
      />,
    );
    expect(await screen.findByText('Point at the label')).toBeVisible();
    expect(camera.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({ facingMode: { ideal: 'environment' } }),
      }),
    );
    expect(screen.getByText('Decoder: ZXing (WebAssembly)')).toBeVisible();

    scene.codes = [{ format: 'qr', text: 'BKT-2026-000014' }];
    expect(await screen.findByText('Found BKT-2026-000014')).toBeVisible();
    await waitFor(() => expect(onFound).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(onFound).toHaveBeenCalledWith({
      id: KNOWN['BKT-2026-000014'],
      readableId: 'BKT-2026-000014',
    });
    // The label was in every frame, but it was looked up and opened once.
    expect(onFound).toHaveBeenCalledTimes(1);
    expect(lookupCount(fetchMock)).toBe(1);
  });

  it('an unknown code is reported once and scanning continues', async () => {
    const fetchMock = stubApi();
    const camera = fakeCamera();
    const { scene, factory, decoder } = fakeDecoder();
    render(
      <CameraScanner
        onClose={vi.fn()}
        onFound={vi.fn()}
        devices={camera.devices}
        secureContext
        decoderFactory={factory}
        readFrame={frame}
      />,
    );
    await screen.findByText('Point at the label');
    scene.codes = [{ format: 'code128', text: 'BKT-1999-000001' }];
    expect(await screen.findByText('No storage unit found for BKT-1999-000001')).toBeVisible();
    // Several more frames still see the code; it isn't looked up again while it stays in view.
    const seen = vi.mocked(decoder.decode).mock.calls.length;
    await waitFor(() =>
      expect(vi.mocked(decoder.decode).mock.calls.length).toBeGreaterThan(seen + 5),
    );
    expect(lookupCount(fetchMock)).toBe(1);
    expect(camera.live()).toHaveLength(1);
  });

  it('AC4: permission denied explains how to re-enable and offers manual entry', async () => {
    stubApi();
    const camera = fakeCamera({ fail: 'NotAllowedError' });
    const onFound = vi.fn();
    render(
      <CameraScanner
        onClose={vi.fn()}
        onFound={onFound}
        devices={camera.devices}
        secureContext
        decoderFactory={fakeDecoder().factory}
        readFrame={frame}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Camera access is blocked' })).toBeVisible();
    expect(screen.getByText(/Website Settings → Camera → Allow/)).toBeVisible();
    expect(screen.getByText(/Permissions → Camera → Allow/)).toBeVisible();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Or type the storage unit ID' }),
      'bkt-2026-000014{Enter}',
    );
    await waitFor(() => expect(onFound).toHaveBeenCalledTimes(1));
  });

  it('AC4: no camera, and an insecure (HTTP) page, are explained without asking', async () => {
    stubApi();
    const missing = fakeCamera({ fail: 'NotFoundError' });
    const { unmount } = render(
      <CameraScanner
        onClose={vi.fn()}
        onFound={vi.fn()}
        devices={missing.devices}
        secureContext
        decoderFactory={fakeDecoder().factory}
        readFrame={frame}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'No camera found' })).toBeVisible();
    unmount();

    const http = fakeCamera();
    render(
      <CameraScanner
        onClose={vi.fn()}
        onFound={vi.fn()}
        devices={http.devices}
        secureContext={false}
        decoderFactory={fakeDecoder().factory}
        readFrame={frame}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'The camera needs a secure (HTTPS) connection' }),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Or type the storage unit ID' })).toBeVisible();
    expect(http.getUserMedia).not.toHaveBeenCalled();
  });

  it('AC5: the stream stops on close, unmount and when the page is hidden', async () => {
    stubApi();
    const camera = fakeCamera({ cameras: ['rear', 'front'], torch: true });
    const onClose = vi.fn();
    const { unmount } = render(
      <CameraScanner
        onClose={onClose}
        onFound={vi.fn()}
        devices={camera.devices}
        secureContext
        decoderFactory={fakeDecoder().factory}
        readFrame={frame}
      />,
    );
    await screen.findByText('Point at the label');

    // Camera switcher and torch where supported.
    await userEvent.click(await screen.findByRole('button', { name: 'Switch camera' }));
    await waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(2));
    expect(camera.getUserMedia.mock.lastCall?.[0]?.video).toMatchObject({
      deviceId: { exact: 'front' },
    });
    await waitFor(() => expect(camera.live()).toHaveLength(1));
    const torch = await screen.findByRole('button', { name: 'Torch' });
    await userEvent.click(torch);
    expect(torch).toHaveAttribute('aria-pressed', 'true');

    // Page hidden: stream stopped, Resume restarts it.
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByText('Camera paused')).toBeVisible();
    expect(camera.live()).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Resume camera' }));
    await waitFor(() => expect(camera.live()).toHaveLength(1));

    await userEvent.click(screen.getByRole('button', { name: 'Close camera' }));
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(camera.live()).toHaveLength(0);
    expect(camera.tracks.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
  });
});

describe('Scan with camera button (TRP-T17)', () => {
  const me: MeResponse = {
    id: 'u1',
    displayName: 'Dana Example',
    initials: 'DE',
    accountType: 'test',
    status: 'active',
    roles: [],
    permissions: ['inventory.read'],
    sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  };

  it('AC2: no camera request until Scan with camera is tapped', async () => {
    stubApi();
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    const router = createMemoryRouter(routes, { initialEntries: ['/sample-storage'] });
    render(
      <SessionContext.Provider
        value={{
          session: { status: 'active', me },
          refresh: vi.fn(async () => undefined),
          signOut: vi.fn(async () => undefined),
        }}
      >
        <RouterProvider router={router} />
      </SessionContext.Provider>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Sample Storage' });
    await act(() => router.navigate('/sample-storage/scan'));
    const button = await screen.findByRole('button', { name: 'Scan with camera' });
    expect(getUserMedia).not.toHaveBeenCalled();

    await userEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Scan with camera' })).toBeVisible();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('heading', { name: 'Camera access is blocked' })).toBeVisible();
    Reflect.deleteProperty(navigator, 'mediaDevices');
    Reflect.deleteProperty(window, 'isSecureContext');
  });
});
