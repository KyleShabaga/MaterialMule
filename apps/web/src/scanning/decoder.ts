// Barcode decoder adapter (MM-T17), so the camera scanner doesn't care which decoder runs and
// the choice can change after the device spike. Two implementations:
//   native — the browser's BarcodeDetector (Android Chrome and some others), when it supports
//            both Code 128 and QR;
//   zxing  — zxing-wasm (MIT), ZXing-C++ compiled to WebAssembly, served from Material Mule itself
//            (never a CDN) and loaded only when the camera is opened.
// "auto" (the default) prefers native and falls back to zxing. `?decoder=zxing` or
// `?decoder=native` on the page forces one, for comparing them on a phone.

export interface DecodedSymbol {
  format: 'code128' | 'qr';
  text: string;
}

export interface BarcodeDecoder {
  readonly name: 'native' | 'zxing';
  /** Decodes one frame locally; resolves to the symbols found (possibly none). */
  decode(frame: ImageData): Promise<DecodedSymbol[]>;
}

export type DecoderPreference = 'auto' | 'native' | 'zxing';
export type DecoderFactory = (preference: DecoderPreference) => Promise<BarcodeDecoder>;

export const DECODER_LABEL: Record<BarcodeDecoder['name'], string> = {
  native: 'Built-in barcode detector',
  zxing: 'ZXing (WebAssembly)',
};

export function readDecoderPreference(search: string): DecoderPreference {
  const value = new URLSearchParams(search).get('decoder');
  return value === 'native' || value === 'zxing' ? value : 'auto';
}

interface DetectedBarcode {
  rawValue: string;
  format: string;
}

interface BarcodeDetectorConstructor {
  new (options: { formats: string[] }): { detect(source: ImageData): Promise<DetectedBarcode[]> };
  getSupportedFormats(): Promise<string[]>;
}

const NATIVE_FORMATS = ['code_128', 'qr_code'];

async function createNativeDecoder(): Promise<BarcodeDecoder | null> {
  const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (!Detector) return null;
  try {
    const supported = await Detector.getSupportedFormats();
    if (!NATIVE_FORMATS.every((format) => supported.includes(format))) return null;
    const detector = new Detector({ formats: NATIVE_FORMATS });
    return {
      name: 'native',
      async decode(frame) {
        const found = await detector.detect(frame);
        return found.map((barcode) => ({
          format: barcode.format === 'qr_code' ? 'qr' : 'code128',
          text: barcode.rawValue,
        }));
      },
    };
  } catch {
    return null;
  }
}

/** The decoder for this browser. Rejects only if no decoder can be loaded at all. */
export const createBarcodeDecoder: DecoderFactory = async (preference) => {
  if (preference !== 'zxing') {
    const native = await createNativeDecoder();
    if (native) return native;
    if (preference === 'native') throw new Error('This browser has no built-in barcode detector.');
  }
  const { createZxingDecoder } = await import('./zxing-decoder');
  return createZxingDecoder();
};
