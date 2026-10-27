import type { ReactNode } from 'react';
import { DonkeyMark } from '../layout/DonkeyMark';
import './auth.css';

/**
 * Standalone pages outside the app shell (MM-T50 canvas "Sign-in screens"): sign in, test
 * sign-in, Microsoft sign-in errors, access pending and first sign-in. One centred column on the
 * page ground; `wide` for the pages with lists or choices.
 */
export function AuthPage({
  wide = false,
  role,
  busy,
  children,
}: {
  wide?: boolean;
  role?: 'alert';
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="auth-page">
      <main
        className={wide ? 'auth-main auth-main-wide' : 'auth-main'}
        role={role}
        aria-busy={busy || undefined}
      >
        {children}
      </main>
    </div>
  );
}

/** The walking-donkey mark (48px box) beside the name, and the product line under it. */
export function AuthBrand() {
  return (
    <div className="auth-brand">
      <div className="auth-brand-name">
        <span className="auth-mark">
          <DonkeyMark />
        </span>
        <h1>Material Mule</h1>
      </div>
      <p className="auth-tagline">Sample receiving and storage tracking</p>
    </div>
  );
}
