import { inventoryPageSchema, projectListPageSchema, type MeResponse } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client';
import { fetchDashboardCounts } from '../concrete/lab/api';
import { FEATURES } from '../features';
import type { DestinationKey } from '../layout/nav';
import { indexedDbDraftStore } from '../receiving/drafts/store';
import { visibleTo } from '../receiving/drafts/record';
import { fetchOpenPrograms, fetchRetentionDue } from './api';

// Phone More sheet (canvas PhoneMore): one count per destination, each read from the list the
// destination opens. Counts that can't be read (no permission, offline) are simply left out.

export type MoreCounts = Partial<Record<DestinationKey, number>>;

async function total(path: string): Promise<number | null> {
  try {
    const response = await apiFetch(path);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const inventory = inventoryPageSchema.safeParse(body);
    if (inventory.success) return inventory.data.total;
    const projects = projectListPageSchema.safeParse(body);
    return projects.success ? projects.data.total : null;
  } catch {
    return null;
  }
}

export async function loadMoreCounts(me: MeResponse): Promise<MoreCounts> {
  const has = (permission: string) => (me.permissions as readonly string[]).includes(permission);
  const [inventory, projects, retention, programs, concrete, drafts] = await Promise.all([
    total('/api/inventory?pageSize=1'),
    total('/api/projects?pageSize=1'),
    FEATURES.disposalRetention ? fetchRetentionDue() : null,
    FEATURES.labTesting && has('lab_program.read') ? fetchOpenPrograms() : null,
    FEATURES.concreteLab ? fetchDashboardCounts() : null,
    indexedDbDraftStore.list().then(
      ({ drafts: all }) => all.filter((d) => visibleTo(d, me)).length,
      () => null,
    ),
  ]);
  const counts: MoreCounts = {};
  if (inventory !== null) counts.inventory = inventory;
  if (projects !== null) counts.projects = projects;
  if (retention?.ok) counts.retention = retention.data.total;
  if (programs?.ok) counts.lab = programs.data.total;
  if (concrete?.ok) counts.concrete = concrete.data.testsToday;
  if (drafts !== null) counts.receive = drafts;
  return counts;
}

/** Counts for the More sheet, read each time it opens. */
export function useMoreCounts(open: boolean, me: MeResponse): MoreCounts {
  const [counts, setCounts] = useState<MoreCounts>({});
  useEffect(() => {
    if (!open) return;
    let active = true;
    void loadMoreCounts(me).then((value) => active && setCounts(value));
    return () => {
      active = false;
    };
  }, [open, me]);
  return counts;
}
