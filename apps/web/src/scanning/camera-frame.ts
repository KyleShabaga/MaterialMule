import { CAMERA_MAX_DECODE_WIDTH } from './camera-core';

/** Reads the video's current frame into memory for the decoder; null until a frame is ready. */
export type FrameReader = (video: HTMLVideoElement) => ImageData | null;

/** A frame reader drawing onto its own off-screen canvas (frames never leave the browser). */
export function createFrameReader(): FrameReader {
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  return (video) => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
      return null;
    }
    const scale = Math.min(1, CAMERA_MAX_DECODE_WIDTH / video.videoWidth);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    canvas ??= document.createElement('canvas');
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      context = null;
    }
    context ??= canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  };
}
