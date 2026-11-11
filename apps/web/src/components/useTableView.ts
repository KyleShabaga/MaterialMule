import { useCallback, useState } from 'react';
import { useMediaQuery } from './useMediaQuery';

// Field Ledger table view (docs/redesign/design.md, "Table view selector"); the selector
// itself is TableViewSelector in ui.tsx.

export type TableView = 'comfortable' | 'compact';

export const TABLE_VIEW_STORAGE_PREFIX = 'materialmule:table-view:';

export const PHONE_QUERY = '(max-width: 640px)';

function readTableView(tableKey: string): TableView {
  try {
    return window.localStorage.getItem(TABLE_VIEW_STORAGE_PREFIX + tableKey) === 'compact'
      ? 'compact'
      : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/**
 * The comfortable / compact choice for one table, remembered per table in this browser.
 * Phones always get comfortable (compact is for mouse use on a desktop), whatever is stored.
 */
export function useTableView(tableKey: string): [TableView, (view: TableView) => void] {
  const [stored, setStored] = useState<TableView>(() => readTableView(tableKey));
  const phone = useMediaQuery(PHONE_QUERY);
  const set = useCallback(
    (view: TableView) => {
      setStored(view);
      try {
        window.localStorage.setItem(TABLE_VIEW_STORAGE_PREFIX + tableKey, view);
      } catch {
        // Storage blocked (private window, policy): the choice lasts for this page only.
      }
    },
    [tableKey],
  );
  return [phone ? 'comfortable' : stored, set];
}
