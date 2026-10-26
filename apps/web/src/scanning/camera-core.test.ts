import { describe, expect, it } from 'vitest';
import {
  CAMERA_REPEAT_MS,
  CameraScanGate,
  cameraConstraints,
  cameraPrecheck,
  classifyCameraError,
} from './camera-core';
import { readDecoderPreference } from './decoder';

describe('CameraScanGate (T17 T1: duplicate suppression)', () => {
  it('acts once while the same label stays in view, however many frames decode it', () => {
    const gate = new CameraScanGate();
    const acted: string[] = [];
    for (let frame = 0; frame < 25; frame++) {
      const code = gate.next(['BKT-2026-000014'], frame * 100);
      if (code) acted.push(code);
    }
    expect(acted).toEqual(['BKT-2026-000014']);
  });

  it('acts again after the code leaves the frame', () => {
    const gate = new CameraScanGate();
    expect(gate.next(['BKT-2026-000014'], 0)).toBe('BKT-2026-000014');
    expect(gate.next(['BKT-2026-000014'], 100)).toBeNull();
    expect(gate.next([], 200)).toBeNull();
    expect(gate.next(['BKT-2026-000014'], 300)).toBe('BKT-2026-000014');
  });

  it('acts again after 3 s even if the code never left', () => {
    const gate = new CameraScanGate();
    expect(gate.next(['ST-2026-000003'], 0)).toBe('ST-2026-000003');
    expect(gate.next(['ST-2026-000003'], CAMERA_REPEAT_MS - 1)).toBeNull();
    expect(gate.next(['ST-2026-000003'], CAMERA_REPEAT_MS)).toBe('ST-2026-000003');
  });

  it('acts on a different code at once, and resets for Retry', () => {
    const gate = new CameraScanGate();
    expect(gate.next(['BKT-2026-000014'], 0)).toBe('BKT-2026-000014');
    expect(gate.next(['BKT-2026-000014', 'ST-2026-000003'], 100)).toBe('ST-2026-000003');
    gate.reset();
    expect(gate.next(['ST-2026-000003'], 200)).toBe('ST-2026-000003');
  });
});

describe('camera start-up rules', () => {
  it('asks for the rear camera at a capped resolution, or a chosen camera', () => {
    expect(cameraConstraints()).toEqual({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
      },
    });
    expect(cameraConstraints('cam-2').video).toMatchObject({ deviceId: { exact: 'cam-2' } });
  });

  it('refuses insecure (HTTP) pages before asking, and browsers without camera access', () => {
    expect(cameraPrecheck({ isSecureContext: false, hasGetUserMedia: true })).toBe('insecure');
    expect(cameraPrecheck({ isSecureContext: false, hasGetUserMedia: false })).toBe('insecure');
    expect(cameraPrecheck({ isSecureContext: true, hasGetUserMedia: false })).toBe('no_camera');
    expect(cameraPrecheck({ isSecureContext: true, hasGetUserMedia: true })).toBeNull();
  });

  it('explains getUserMedia failures', () => {
    const error = (name: string) => new DOMException('x', name);
    expect(classifyCameraError(error('NotAllowedError'))).toBe('denied');
    expect(classifyCameraError(error('SecurityError'))).toBe('denied');
    expect(classifyCameraError(error('NotFoundError'))).toBe('no_camera');
    expect(classifyCameraError(error('OverconstrainedError'))).toBe('no_camera');
    expect(classifyCameraError(error('NotReadableError'))).toBe('in_use');
    expect(classifyCameraError(new Error('boom'))).toBe('failed');
    expect(classifyCameraError('weird')).toBe('failed');
  });

  it('reads a forced decoder from the page URL for device comparisons', () => {
    expect(readDecoderPreference('?decoder=zxing')).toBe('zxing');
    expect(readDecoderPreference('?decoder=native')).toBe('native');
    expect(readDecoderPreference('?decoder=other')).toBe('auto');
    expect(readDecoderPreference('')).toBe('auto');
  });
});
