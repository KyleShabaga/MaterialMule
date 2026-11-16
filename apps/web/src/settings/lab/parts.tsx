import { CircleAlert, RefreshCw, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { LOAD_FAILED_HINT } from './catalogue';

// Small pieces shared by Lab tests and Templates (STRATA-102/128).

/** Available (storage green) or Retired (closed grey), as on the R9 Lab tests board. */
export function CatalogueStatus({ active }: { active: boolean }) {
  return (
    <Badge variant={active ? 'storage' : 'closed'}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {active ? 'Available' : 'Retired'}
    </Badge>
  );
}

export function LoadFailed({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{LOAD_FAILED_HINT}</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function LoadingRows({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="grid gap-2">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-2/3" />
    </div>
  );
}

/** An inline problem in a drawer or form: a toast is never the only place a failure shows. */
export function ProblemAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>
        <p>{children}</p>
      </AlertDescription>
    </Alert>
  );
}

/** Always-visible search box and an "Include retired" tick, for the unpaged catalogue lists. */
export function CatalogueFilters({
  id,
  searchLabel,
  placeholder,
  query,
  onQueryChange,
  includeRetired,
  onIncludeRetiredChange,
  retiredCount,
}: {
  id: string;
  searchLabel: string;
  placeholder: string;
  query: string;
  onQueryChange: (query: string) => void;
  includeRetired: boolean;
  onIncludeRetiredChange: (include: boolean) => void;
  retiredCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <InputGroup className="w-full sm:w-72">
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label={searchLabel}
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </InputGroup>
      <div className="flex items-center gap-2 pointer-coarse:min-h-11">
        <Checkbox
          id={`${id}-retired`}
          checked={includeRetired}
          onCheckedChange={(checked) => onIncludeRetiredChange(checked === true)}
        />
        <Label htmlFor={`${id}-retired`} className="font-normal">
          Include retired{retiredCount > 0 ? ` (${retiredCount})` : ''}
        </Label>
      </div>
    </div>
  );
}
