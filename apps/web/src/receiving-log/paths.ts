// Links from the Receiving log into the receiving wizard (Field Ledger, lane B).

/** "Start a delivery": always a new draft (`?new=1`), never the list of drafts. */
export const START_DELIVERY_PATH = '/receiving-log/new?new=1';

/** Opens one draft saved on this computer in the receiving wizard. */
export const continueDraftPath = (draftId: string) =>
  `/receiving-log/new?draft=${encodeURIComponent(draftId)}`;
