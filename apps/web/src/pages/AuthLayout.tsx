import { Building2, CircleQuestionMark } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { DonkeyMark } from '../layout/DonkeyMark';
import './auth.css';

/** The donkey on its indigo tile, the name and the one-line description (DESIGN.md › Sign in). */
export function AuthBrand() {
  return (
    <div className="flex items-center gap-3">
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
        aria-hidden="true"
      >
        <DonkeyMark />
      </span>
      <span className="grid min-w-0 leading-tight">
        <span className="text-lg font-semibold">Material Mule</span>
        <span className="text-[13px] text-muted-foreground">Sample storage and lab testing</span>
      </span>
    </div>
  );
}

/**
 * The sign-in background: two soft radial glows of `primary` over a 135° wash from `accent`
 * through `background`, built from the theme variables (auth.css), so light and dark follow on
 * their own. Decoration only: hidden from assistive technology and from the pointer.
 */
export function SignInBackground() {
  return (
    <div
      aria-hidden="true"
      data-testid="sign-in-background"
      className="sign-in-gradient pointer-events-none absolute inset-0"
    />
  );
}

/**
 * The sign-in layout (STRATA-17, round 10): one centred 440 px column with the brand, the content
 * on a card and the "Works on the office network only" footer, over the gradient. Used by sign-in,
 * the Microsoft sign-in return, Waiting for approval, Material Mule is unavailable, test sign-in
 * and the LAB station's "Who is working here?" step (station agent).
 *
 * - `card={false}` leaves the content without the card (a page with its own cards).
 * - `wide` widens the column to 640 px (test sign-in's list of people).
 * - `help` adds the Help link in the footer (signed-out /help, round 10).
 * - `beforeFooter` sits between the card and the footer (development-only test sign-in).
 */
export function SignInLayout({
  children,
  card = true,
  wide = false,
  help = true,
  busy,
  beforeFooter,
}: {
  children: ReactNode;
  card?: boolean;
  wide?: boolean;
  help?: boolean;
  busy?: boolean;
  beforeFooter?: ReactNode;
}) {
  return (
    <div className="relative isolate flex min-h-svh flex-col bg-background text-foreground">
      <SignInBackground />
      <main
        className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 py-10"
        aria-busy={busy || undefined}
      >
        <div className={cn('flex w-full flex-col gap-6', wide ? 'max-w-[640px]' : 'max-w-[440px]')}>
          <AuthBrand />
          {card ? (
            <Card className="gap-6 rounded-[10px] p-8 max-sm:p-6">{children}</Card>
          ) : (
            children
          )}
          <div className="flex flex-col gap-3 text-[13px] text-muted-foreground">
            {beforeFooter}
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2">
                <Building2 className="size-4" aria-hidden="true" />
                Works on the office network only
              </p>
              {help ? (
                <Button asChild variant="link" size="sm" className="h-auto p-0 text-[13px]">
                  <Link to="/help">
                    <CircleQuestionMark aria-hidden="true" />
                    Help
                  </Link>
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * A system page's opening on the sign-in card: a round tinted icon, then the h1 and one plain
 * sentence, so screen readers get the heading first, then the message (round 10).
 */
export function SignInCardHeading({
  id,
  icon: Icon,
  tone = 'muted',
  title,
  children,
}: {
  id: string;
  icon: ComponentType<{ className?: string }>;
  tone?: 'muted' | 'accent' | 'due' | 'danger';
  title: ReactNode;
  children?: ReactNode;
}) {
  const toneClass = {
    muted: 'bg-muted text-muted-foreground',
    accent: 'bg-accent text-accent-foreground',
    due: 'bg-stage-due-bg text-stage-due-fg',
    danger: 'bg-stage-danger-bg text-stage-danger-fg',
  }[tone];
  return (
    <div className="flex flex-col items-start gap-4">
      <span
        className={cn('flex size-10 items-center justify-center rounded-full', toneClass)}
        aria-hidden="true"
      >
        <Icon className="size-5" />
      </span>
      <div className="grid min-w-0 gap-1">
        <h1 id={id} className="text-2xl font-semibold text-balance">
          {title}
        </h1>
        {children ? <p className="text-sm text-muted-foreground">{children}</p> : null}
      </div>
    </div>
  );
}
