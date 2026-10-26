// Phone-camera scanning rules (TRP-T17), kept free of React and browser APIs so they can be
// unit-tested. Frames are only ever processed in the browser; nothing here sends or stores them.

/** The same code is ignored until it leaves the frame or this long has passed (T17 scope). */
export const CAMERA_REPEAT_MS = 3000;

/** About 10 decode attempts per second, to protect the battery (T17 §4). */
export const CAMERA_FRAME_INTERVAL_MS = 100;

/** How long "Found BKT-…" shows before the unit opens. */
export const CAMERA_FOUND_DELAY_MS = 700;

/** Frames wider than this are scaled down before decoding. */
export const CAMERA_MAX_DECODE_WIDTH = 1280;

/** Rear camera by default, resolution capped (T17 §4). */
export function cameraConstraints(deviceId?: string): MediaStreamConstraints {
  const size = { width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 } };
  return {
    audio: false,
    video: deviceId
      ? { deviceId: { exact: deviceId }, ...size }
      : { facingMode: { ideal: 'environment' }, ...size },
  };
}

/**
 * Turns each frame's decoded codes into at most one code to act on. A code is acted on once,
 * then ignored while it stays in view; it counts again after it leaves the frame (a frame without
 * it) or after `repeatMs`. A different code is acted on at once.
 */
export class CameraScanGate {
  private last: { code: string; at: number } | null = null;
  private leftFrame = false;

  constructor(private readonly repeatMs = CAMERA_REPEAT_MS) {}

  next(codes: readonly string[], now: number): string | null {
    const last = this.last;
    if (last && !codes.includes(last.code)) this.leftFrame = true;
    const fresh = codes.find(
      (code) => !last || code !== last.code || this.leftFrame || now - last.at >= this.repeatMs,
    );
    if (fresh === undefined) return null;
    this.last = { code: fresh, at: now };
    this.leftFrame = false;
    return fresh;
  }

  /** Forget the last code (e.g. Retry after the server was unreachable). */
  reset(): void {
    this.last = null;
    this.leftFrame = false;
  }
}

export type CameraProblem = 'insecure' | 'denied' | 'no_camera' | 'in_use' | 'failed';

/** Why the camera can't start, before asking: HTTP pages and browsers without camera access. */
export function cameraPrecheck(env: {
  isSecureContext: boolean;
  hasGetUserMedia: boolean;
}): CameraProblem | null {
  if (!env.isSecureContext) return 'insecure';
  if (!env.hasGetUserMedia) return 'no_camera';
  return null;
}

/** Maps a getUserMedia failure to what the screen explains. */
export function classifyCameraError(error: unknown): CameraProblem {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no_camera';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in_use';
    default:
      return 'failed';
  }
}
