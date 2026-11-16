import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

/**
 * The page area while a page's code loads, inside the shell: a quiet skeleton of a page header
 * and a few rows, so the sidebar and top bar stay put and nothing jumps. It stays invisible for
 * the first 300 ms, so a fast load (a cached chunk) shows nothing at all.
 */
export function PageLoading() {
  return (
    <div className="route-loading flex flex-col gap-6" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-64 max-w-full" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-5/6" />
      </div>
    </div>
  );
}

/** A whole-window page (sign-in, label sheets) while its code loads: the session's own loader. */
export function FullPageLoading() {
  return (
    <p
      className="route-loading flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground"
      aria-busy="true"
    >
      <Spinner role="presentation" aria-hidden="true" aria-label={undefined} />
      Loading…
    </p>
  );
}
