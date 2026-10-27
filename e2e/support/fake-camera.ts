import type { Page } from '@playwright/test';
import { Resvg } from '@resvg/resvg-js';
import { renderPreviewSvg } from '../../apps/api/src/labels/preview';
import {
  CODE128,
  LABEL_HEIGHT_DOTS,
  LABEL_WIDTH_DOTS,
  QR,
} from '../../apps/api/src/labels/template-v1';

// MM-T17 E2E: a fake phone camera. The "camera" films a real-size image of a T14 label (the same
// symbol data the printer gets), so the app's real decoder has to read it. Fictional data only.

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which part of the label is in front of the camera. */
export function labelCrop(part: 'code128' | 'qr' | 'whole' | 'text'): Crop {
  switch (part) {
    case 'code128': {
      const quiet = CODE128.quietZoneModules * CODE128.moduleWidth;
      return {
        x: CODE128.x - quiet,
        y: CODE128.y - 10,
        w: CODE128.maxModules * CODE128.moduleWidth + 2 * quiet,
        h: CODE128.barHeight + 20,
      };
    }
    case 'qr': {
      const quiet = QR.quietZoneModules * QR.magnification;
      const size = QR.maxModules * QR.magnification + 2 * quiet;
      return { x: QR.x - quiet, y: QR.y - quiet, w: size, h: size };
    }
    case 'text':
      // The printed text only: no symbol in view.
      return { x: 20, y: 20, w: 500, h: 250 };
    default:
      return { x: 0, y: 0, w: LABEL_WIDTH_DOTS, h: LABEL_HEIGHT_DOTS };
  }
}

/** A PNG data URL of the label for `storageUnitId` at its real 300 dpi size. */
export function labelImage(storageUnitId: string): string {
  const { svg } = renderPreviewSvg({
    storageUnitId,
    projectNumber: 'DEMO-2601',
    projectName: 'Riverbank investigation',
    receivedDate: '2026-10-26',
    testHoles: ['TH26-01'],
  });
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: LABEL_WIDTH_DOTS },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

export interface FakeCameraOptions {
  image?: string;
  crop?: Crop;
  /** getUserMedia rejects with this DOMException name (e.g. NotAllowedError). */
  fail?: string;
}

/**
 * Replaces navigator.mediaDevices.getUserMedia before the app loads. Calls are counted and every
 * track handed out is kept in `window.__fakeCamera`, so tests can check the camera was never
 * requested, or that every track has stopped (the browser's camera indicator going off).
 */
export async function installFakeCamera(page: Page, options: FakeCameraOptions): Promise<void> {
  await page.addInitScript((opts: FakeCameraOptions) => {
    const state = { calls: 0, tracks: [] as MediaStreamTrack[] };
    (window as unknown as { __fakeCamera: typeof state }).__fakeCamera = state;
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;
    mediaDevices.getUserMedia = async () => {
      state.calls += 1;
      if (opts.fail) throw new DOMException('Fake camera', opts.fail);
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext('2d')!;
      const image = new Image();
      if (opts.image) {
        image.src = opts.image;
        await image.decode();
      }
      const draw = () => {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        if (!opts.image || !opts.crop) return;
        const { x, y, w, h } = opts.crop;
        const scale = Math.min((canvas.width * 0.8) / w, (canvas.height * 0.8) / h);
        context.imageSmoothingEnabled = false;
        context.drawImage(
          image,
          x,
          y,
          w,
          h,
          (canvas.width - w * scale) / 2,
          (canvas.height - h * scale) / 2,
          w * scale,
          h * scale,
        );
      };
      draw();
      const timer = setInterval(draw, 100);
      const stream = canvas.captureStream(15);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(timer);
          stop();
        };
        state.tracks.push(track);
      }
      return stream;
    };
  }, options);
}

export async function cameraState(page: Page): Promise<{ calls: number; live: number }> {
  return page.evaluate(() => {
    const state = (
      window as unknown as { __fakeCamera?: { calls: number; tracks: MediaStreamTrack[] } }
    ).__fakeCamera;
    return {
      calls: state?.calls ?? 0,
      live: state?.tracks.filter((track) => track.readyState === 'live').length ?? 0,
    };
  });
}
