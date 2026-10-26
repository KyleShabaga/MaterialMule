# Phone-camera scanning (MM-T17)

Staff away from the handheld scanner can look a storage unit up with their phone: **Sample
Storage → Scan with camera** (also on **Scan labels**). The phone's browser films the label,
reads its Code 128 or QR (both encode exactly `PREFIX-YYYY-NNNNNN`, MM-T14) and opens the unit.
There is no phone app (D22). Scanning only looks up; it never moves anything (moves are MM-T28).

## How it behaves

- The camera permission prompt appears only after **Scan with camera** is tapped, never on its
  own.
- Rear camera by default. **Switch camera** appears when the phone has more than one camera, and
  **Torch** appears where the browser supports it (mostly Android Chrome).
- A label in view is looked up once. It is ignored until it leaves the picture or 3 seconds pass,
  so holding the phone still never opens the unit twice. On a match the phone vibrates (where
  supported), shows **Found BKT-…** briefly and opens the unit.
- The camera turns off when the scanner is closed (button or Escape), when another page opens,
  and when the phone switches app or locks (**Resume camera** brings it back).
- **Or type the storage unit ID** stays visible in every state, including when the camera is
  blocked or missing.
- Frames are decoded in the browser and never uploaded or stored. About 10 frames a second are
  checked at no more than 1280 pixels wide, which saves battery.

## HTTPS is required

Browsers only allow the camera on secure pages: `https://…`, or `http://localhost` /
`http://127.0.0.1` on the PC itself. On the office network, phones must open Material Mule at its
HTTPS address from the Windows host (MM-T20, `docs/operations/runbook.md`). On plain
`http://<pc-name>` the scanner explains this and offers manual entry instead.

## Decoder

The decoder sits behind an adapter (`apps/web/src/scanning/decoder.ts`), so it can be swapped:

| Name   | What                                                                                    | Where it runs                                     |
| ------ | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| native | The browser's `BarcodeDetector`                                                         | Android Chrome; not iOS Safari or desktop Windows |
| zxing  | [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 3.x (MIT), ZXing-C++ in WebAssembly | Every current browser                             |

**Current (provisional) choice:** _auto_. It uses `BarcodeDetector` when it supports both Code 128
and QR, and otherwise ZXing. The ZXing WebAssembly file (about 0.9 MB, 0.4 MB gzipped) is served
by Material Mule itself, never from a CDN, and is downloaded only when the camera is first opened. The
scanner shows which decoder is running ("Decoder: …").

The card asks for the choice to be made from a spike on real staff phones. Add `?decoder=native`
or `?decoder=zxing` to the page address (for example `/sample-storage?decoder=zxing`) to force
one decoder while comparing them on the same phone. Record the results below, then fix the
choice in `createBarcodeDecoder` if _auto_ turns out to be wrong.

## Device test (card T4): to be recorded by Kyle

Not run yet: no staff phones or internal HTTPS were available when MM-T17 was built. Automated
tests use a fake camera that films a generated label image.

| Phone / OS / browser                | Decoder | Code 128 | QR  | Time to open (≈2 s?) | Low light | Worn label | Notes |
| ----------------------------------- | ------- | -------- | --- | -------------------- | --------- | ---------- | ----- |
| iPhone \_\_\_ / iOS \_\_\_ / Safari | zxing   |          |     |                      |           |            |       |
| Android \_\_\_ / \_\_\_ / Chrome    | native  |          |     |                      |           |            |       |
| Android \_\_\_ / \_\_\_ / Chrome    | zxing   |          |     |                      |           |            |       |

Also check on each phone: no permission prompt before tapping; denied permission shows the
instructions; the camera indicator turns off after Close and after opening the unit.
