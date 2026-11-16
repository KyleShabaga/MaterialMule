import { expect, type Locator, type Page } from '@playwright/test';

// The Inbox (STRATA-24; DESIGN.md › Inbox) for specs: every action request and update in one
// list at /inbox. A row is a list item named by its title. Opening it shows the item in the
// drawer from 1024 px, or as its own page (/inbox/:key) on narrower screens; either way the item
// is a region named by its title, holding one article with the details and actions.

/** The Inbox URL with a search (title, job number, record or sender) and optional tab/filter. */
export function inboxUrl(
  search: string,
  options: { tab?: 'all' | 'requests' | 'updates' | 'done'; filter?: string } = {},
): string {
  const params = new URLSearchParams();
  if (options.tab && options.tab !== 'all') params.set('tab', options.tab);
  if (options.filter) params.append('filter', options.filter);
  if (search) params.set('search', search);
  const query = params.toString();
  return query ? `/inbox?${query}` : '/inbox';
}

/** One row of the list, by its title. */
export function inboxRow(page: Page, title: string): Locator {
  return page.getByRole('listitem', { name: title, exact: true });
}

/**
 * Opens a row (drawer or full page, by screen width) and returns the item's details: the article
 * inside the region named by its title.
 */
export async function openInboxItem(page: Page, row: Locator, title: string): Promise<Locator> {
  await row.getByRole('button').click();
  const item = page.getByRole('region', { name: title, exact: true });
  await expect(item).toBeVisible();
  return item.getByRole('article');
}

interface FeedItem {
  key: string;
  href: string;
  title: string;
  unread: boolean;
  /** Requests only: why it was asked. */
  reason?: string;
}

async function feed(page: Page, search: string, tab: string): Promise<FeedItem[]> {
  const params = new URLSearchParams({ tab, q: search, pageSize: '100' });
  const response = await page.request.get(`/api/inbox?${params.toString()}`);
  return ((await response.json()) as { items: FeedItem[] }).items;
}

/**
 * The feed key of the newest item matching `match`, read from the API (the list shows the same
 * items): for rows whose title isn't unique, e.g. a returned field report, found by its link.
 */
export async function inboxKeyFor(
  page: Page,
  search: string,
  match: (item: FeedItem) => boolean,
  tab: 'all' | 'requests' | 'updates' | 'done' = 'all',
): Promise<string> {
  let key: string | undefined;
  await expect
    .poll(async () => {
      key = (await feed(page, search, tab)).find(match)?.key;
      return key !== undefined;
    })
    .toBe(true);
  return key!;
}

/** Waits until the server has the item with `key` read (opening an item marks it read). */
export async function expectInboxItemRead(
  page: Page,
  search: string,
  key: string,
  tab: 'all' | 'requests' | 'updates' | 'done' = 'all',
): Promise<void> {
  await expect
    .poll(async () => (await feed(page, search, tab)).find((item) => item.key === key)?.unread)
    .toBe(false);
}

/** A row's button by its feed key (rows carry `data-peek-id`), for titles that aren't unique. */
export function inboxRowByKey(page: Page, key: string): Locator {
  return page.locator(`[data-peek-id="${key}"]`);
}
