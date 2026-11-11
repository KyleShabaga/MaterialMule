import type { ReactNode } from 'react';
import { DonkeyMark } from '../layout/DonkeyMark';
import './auth.css';

/** The donkey on its flag tile beside the wordmark (Field Ledger "Logo"). */
export function AuthBrand({ large = false }: { large?: boolean }) {
  return (
    <div className={large ? 'auth-brand auth-brand-large' : 'auth-brand'}>
      <span className="auth-mark" aria-hidden="true">
        <DonkeyMark />
      </span>
      <span className="auth-wordmark">Material Mule</span>
    </div>
  );
}

/**
 * Standalone pages outside the app shell (test sign-in, Microsoft sign-in errors, access
 * pending): a rail-coloured header band with the brand, then one centred column on paper;
 * `wide` for the pages with lists or choices. `headerAction` sits at the right of the band.
 */
export function AuthPage({
  wide = false,
  role,
  busy,
  headerAction,
  children,
}: {
  wide?: boolean;
  role?: 'alert';
  busy?: boolean;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="auth-page">
      <header className="auth-header">
        <AuthBrand />
        {headerAction}
      </header>
      <div className="auth-body">
        <main
          className={wide ? 'auth-main auth-main-wide' : 'auth-main'}
          role={role}
          aria-busy={busy || undefined}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Sign-in split screen (Field Ledger "Sign-in"): an ink panel with the wordmark and one line,
 * and the form on paper. On a phone the panel becomes a short band above the form.
 */
export function AuthSplit({ children }: { children: ReactNode }) {
  return (
    <div className="auth-split">
      <div className="auth-panel">
        <AuthBrand large />
        <div className="auth-panel-lines">
          <p className="auth-panel-line">
            Every bucket, tube and core box, where the record says it is.
          </p>
          <p className="auth-panel-steps">RECEIVE · LABEL · STORE · TEST · RETAIN · DISPOSE</p>
        </div>
        <p className="auth-panel-note">Office network only</p>
      </div>
      <div className="auth-split-form">
        <main className="auth-main auth-main-split">{children}</main>
      </div>
    </div>
  );
}

/**
 * A notice strip with a mono caps tag (States, "Sign-in"): waiting tone for an ended session or
 * a pause, danger for a wrong password. The tag sits outside the live region so the region's
 * text is exactly the message.
 */
export function AuthStrip({
  tag,
  tone,
  live,
  children,
}: {
  tag: string;
  tone: 'waiting' | 'danger';
  live: 'status' | 'alert';
  children: ReactNode;
}) {
  return (
    <div className={`auth-strip auth-strip-${tone}`}>
      <span className="auth-strip-tag" aria-hidden="true">
        {tag}
      </span>
      <div className="auth-strip-text" role={live}>
        {children}
      </div>
    </div>
  );
}
