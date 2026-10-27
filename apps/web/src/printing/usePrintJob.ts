import { isPrintJobActive, type PrintJob } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { fetchPrintJob } from './api';

/** How often a queued or sending job is re-read (card MM-T15: every 2 s while active). */
export const PRINT_POLL_MS = 2_000;

/**
 * Holds the latest copy of a print job and keeps it fresh while the worker is still on it.
 * Polling stops as soon as the job is sent, failed or uncertain.
 */
export function usePrintJob(): [PrintJob | null, (job: PrintJob | null) => void] {
  const [job, setJob] = useState<PrintJob | null>(null);
  const [polls, setPolls] = useState(0);
  const activeId = job && isPrintJobActive(job.status) ? job.id : null;

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchPrintJob(activeId).then((result) => {
        if (cancelled) return;
        // On a failed read keep the last copy and try again next time.
        if (result.ok) setJob(result.data);
        setPolls((count) => count + 1);
      });
    }, PRINT_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeId, polls]);

  return [job, setJob];
}
