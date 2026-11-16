import { isPrintJobActive, type PrintJob } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { fetchPrintJob } from './api';
import { PRINT_POLL_MS } from './usePrintJob';

/**
 * Several print jobs at once (one per copy on the label printing screen), each kept fresh like
 * usePrintJob: every 2 s while the worker is still on it, stopping once it is sent, failed or
 * uncertain. A failed read keeps the last copy and tries again next time.
 */
export function usePrintJobs(): [PrintJob[], (jobs: PrintJob[]) => void] {
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [polls, setPolls] = useState(0);
  const activeKey = jobs
    .filter((job) => isPrintJobActive(job.status))
    .map((job) => job.id)
    .join(',');

  useEffect(() => {
    if (activeKey === '') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const ids = activeKey.split(',');
      void Promise.all(ids.map((id) => fetchPrintJob(id))).then((results) => {
        if (cancelled) return;
        const fresh = new Map(results.flatMap((r) => (r.ok ? [[r.data.id, r.data] as const] : [])));
        setJobs((current) => current.map((job) => fresh.get(job.id) ?? job));
        setPolls((count) => count + 1);
      });
    }, PRINT_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeKey, polls]);

  return [jobs, setJobs];
}
