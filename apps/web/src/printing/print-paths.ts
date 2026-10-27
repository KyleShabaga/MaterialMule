/** Print view paths (no app chrome): one unit, or every label of a receipt. */
export function unitPrintPath(storageUnit: string) {
  return `/labels/print/unit/${encodeURIComponent(storageUnit)}`;
}

/** `fromUnit`: the readable ID of the unit it was opened from, for the back link (MM-T61). */
export function receiptPrintPath(receiptId: string, fromUnit?: string) {
  const path = `/labels/print/receipt/${encodeURIComponent(receiptId)}`;
  return fromUnit ? `${path}?${new URLSearchParams({ from: fromUnit }).toString()}` : path;
}
