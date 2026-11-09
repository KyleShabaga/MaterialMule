import type { ProjectDetail } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { fetchProjectDetail, type LoadResult } from '../../projects/api';

/** Loads the project header once for the Concrete screens (tabs, mix detail, propagation). */
export function useProject(projectId: string) {
  const [result, setResult] = useState<(LoadResult<ProjectDetail> & { key: string }) | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchProjectDetail(projectId).then((response) => {
      if (!cancelled) setResult({ ...response, key: projectId });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloads]);
  return {
    project: result && result.key === projectId ? result : null,
    reload: () => setReloads((n) => n + 1),
  };
}
