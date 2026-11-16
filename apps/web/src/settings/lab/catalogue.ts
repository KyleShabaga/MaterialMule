import type { TestCatalogue, TestTemplate } from '@materialmule/shared';
import { useCallback, useEffect, useState } from 'react';
import { fetchCatalogue, fetchTemplates, type WriteResult } from '../../lab/api';

// Shared by Lab tests (/admin/lab-tests) and Settings › Templates (MM-T23, MISC-04, STRATA-102/128).
// Only Lab Managers and administrators (`test_catalog.manage`) open them; the server refuses every
// catalogue write to anyone else. Nothing is deleted: retired tests and templates leave new
// selection while submitted requests keep their snapshots.

export const CATALOGUE_PERMISSION = 'test_catalog.manage';
export const NOT_ALLOWED_TEXT = 'Only Lab Managers and administrators can change the catalogue.';
export const REFUSED_TEXT = 'Only Lab Managers and administrators can open this page.';
export const LOAD_FAILED_TEXT = 'The catalogue couldn’t be loaded.';
export const LOAD_FAILED_HINT =
  'Check the connection, then try again. Lab programs already submitted aren’t affected.';

export type WriteFailure = Exclude<WriteResult<unknown>, { ok: true }>;

/**
 * The words for a refused catalogue write, or null when every problem is a field error the form
 * shows beside its field (`placed`).
 */
export function problem(result: WriteFailure, placed: readonly string[] = []): string | null {
  if (result.kind === 'conflict') {
    if (result.code === 'test_code_exists') return 'A test with this code already exists.';
    if (result.code === 'test_template_exists') return 'A template with this name already exists.';
    if (result.code === 'test_group_exists' || result.code === 'test_subgroup_exists') {
      return 'That name is already used here.';
    }
    return 'Someone else changed this first. The list has been refreshed; try again.';
  }
  if (result.kind === 'invalid') {
    const rest = result.errors.filter((e) => !placed.includes(e.field));
    if (rest.length === 0 && result.errors.length > 0) return null;
    return rest.map((e) => `${e.field}: ${e.message}`).join(' ') || 'Check the details.';
  }
  if (result.kind === 'forbidden') return NOT_ALLOWED_TEXT;
  return 'Couldn’t save. Try again.';
}

/** Field errors by field name ("is required" reads "Is required"), first message per field. */
export function fieldErrors(result: WriteFailure): Record<string, string> {
  if (result.kind !== 'invalid') return {};
  const byField: Record<string, string> = {};
  for (const error of result.errors) {
    byField[error.field] ??= `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}`;
  }
  return byField;
}

export type Loaded<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: T };

/** Loads once; `reload` keeps what is shown while it refreshes, `retry` shows loading again. */
function useLoaded<T>(fetcher: () => Promise<T>) {
  const [load, setLoad] = useState<Loaded<T>>({ state: 'loading' });
  const reload = useCallback(
    (): Promise<void> =>
      fetcher().then(
        (data) => setLoad({ state: 'ready', data }),
        () => setLoad((current) => (current.state === 'ready' ? current : { state: 'failed' })),
      ),
    [fetcher],
  );
  const retry = useCallback(() => {
    setLoad({ state: 'loading' });
    void reload();
  }, [reload]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { load, reload, retry };
}

export function useCatalogue() {
  return useLoaded<TestCatalogue>(fetchCatalogue);
}

export function useTemplates() {
  return useLoaded<TestTemplate[]>(fetchTemplates);
}
