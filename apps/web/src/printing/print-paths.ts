/** Print view paths (no app chrome): one unit, every label of a receipt, or chosen units. */
export function unitPrintPath(storageUnit: string) {
  return `/labels/print/unit/${encodeURIComponent(storageUnit)}`;
}

/** `fromUnit`: the readable ID of the unit it was opened from, for the back link (MM-T61). */
export function receiptPrintPath(receiptId: string, fromUnit?: string) {
  const path = `/labels/print/receipt/${encodeURIComponent(receiptId)}`;
  return fromUnit ? `${path}?${new URLSearchParams({ from: fromUnit }).toString()}` : path;
}

/** Most labels the chosen-units print view opens at once (the print job limit is higher). */
export const MAX_CHOSEN_LABELS = 50;

/** Units chosen on Inventory (selection bar → Print labels), by readable ID, in order. */
export function unitsLabelPrintPath(readableIds: readonly string[]) {
  const ids = readableIds.slice(0, MAX_CHOSEN_LABELS).join(',');
  return `/labels/print/units?${new URLSearchParams({ ids }).toString()}`;
}
