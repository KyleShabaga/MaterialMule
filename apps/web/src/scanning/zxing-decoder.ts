import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import type { BarcodeDecoder } from './decoder';

// Loaded on demand by decoder.ts. The WebAssembly file is bundled with the web app and served by
// Material Mule: the library's default would fetch it from a public CDN, which the office host can't
// reach and which would tell a third party the app is in use.

export async function createZxingDecoder(): Promise<BarcodeDecoder> {
  await prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? wasmUrl : prefix + path,
    },
    fireImmediately: true,
  });
  return {
    name: 'zxing',
    async decode(frame) {
      const results = await readBarcodes(frame, {
        formats: ['Code128', 'QRCode'],
        maxNumberOfSymbols: 2,
        tryHarder: true,
      });
      return results
        .filter((result) => result.isValid)
        .map((result) => ({
          format: result.format === 'QRCode' ? 'qr' : 'code128',
          text: result.text,
        }));
    },
  };
}
