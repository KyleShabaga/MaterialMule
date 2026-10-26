/** Print view paths (no app chrome): one unit, or every label of a receipt. */
export function unitPrintPath(storageUnit: string) {
  return `/labels/print/unit/${encodeURIComponent(storageUnit)}`;
}

export function receiptPrintPath(receiptId: string) {
  return `/labels/print/receipt/${encodeURIComponent(receiptId)}`;
}
