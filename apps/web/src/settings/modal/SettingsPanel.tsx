import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One Settings section inside the modal (DESIGN.md › Settings, round 9): it scrolls inside the
 * modal, which keeps its size. Narrow sections (Account, Receiving, System status) use a 640 px
 * column; wide admin panels (Printers, Templates, Concrete reference) pass `wide`.
 *
 * The heading is an h2: the modal's own title ("Settings") is the dialog name, and the page
 * behind keeps its h1.
 */
export function SettingsPanel({
  id,
  title,
  description,
  actions,
  notice,
  wide = false,
  children,
}: {
  /** Used for the heading id (`${id}-title`), which names the section's region. */
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** The section's main action, at the top right (e.g. Add printer). */
  actions?: ReactNode;
  /** An alert above the heading (e.g. "Staff isn't available to you."). */
  notice?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-h-0 flex-1 overflow-y-auto"
      data-settings-panel={id}
    >
      <div
        className={cn(
          'mx-auto px-6 pt-10 pb-16 md:px-10',
          wide ? 'max-w-[1040px]' : 'max-w-[640px]',
        )}
      >
        {notice ? <div className="mb-6">{notice}</div> : null}
        <div className="flex flex-wrap items-start justify-between gap-4 pr-10">
          <div className="grid min-w-0 gap-1">
            <h2 id={`${id}-title`} className="text-2xl font-semibold tracking-tight">
              {title}
            </h2>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
        <div className="mt-8 grid gap-8">{children}</div>
      </div>
    </section>
  );
}

/** A group inside a section: an h3 over a rule, then its rows. */
export function SettingsGroup({
  id,
  title,
  children,
}: {
  id: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="border-b pb-3 text-base font-semibold">
        {title}
      </h3>
      <div className="divide-y">{children}</div>
    </section>
  );
}

/** A label and description on the left, its control on the right. */
export function SettingsRow({
  labelId,
  label,
  description,
  control,
}: {
  labelId?: string;
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-8 py-4">
      <div className="grid min-w-0 gap-1">
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
        {description ? <span className="text-sm text-muted-foreground">{description}</span> : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  );
}
