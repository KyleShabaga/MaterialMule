import type { StorageUnitTableView } from './StorageUnitTable';

// Sample Storage's Standard / Compact table choice (MM-T66 UI-10), remembered on this browser like
// the Projects "Only mine" choice. Storage can be refused (private windows); then it's Standard.

const KEY = 'materialmule.sampleStorage.tableView';

export function readTableView(): StorageUnitTableView {
  try {
    return window.localStorage.getItem(KEY) === 'compact' ? 'compact' : 'standard';
  } catch {
    return 'standard';
  }
}

export function rememberTableView(view: StorageUnitTableView): void {
  try {
    window.localStorage.setItem(KEY, view);
  } catch {
    // Not remembered; the choice still applies until the page is left.
  }
}
