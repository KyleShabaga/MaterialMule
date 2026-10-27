import {
  POSITIONS,
  POSITION_LABELS,
  profileResponseSchema,
  type Position,
} from '@materialmule/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { apiFetch } from '../api/client';
import { useSession } from '../session/context';
import { AuthPage } from './AuthLayout';

/**
 * First-login position setup (MM-T05). Shown after a person's first Microsoft sign-in until they
 * save, including on later sign-ins if they left without saving. The imported job title is only
 * a reference, and the choice grants no permission.
 */
export function PositionSetupPage() {
  const { session, refresh, signOut } = useSession();
  const navigate = useNavigate();
  const [jobTitle, setJobTitle] = useState<string | null>(null);
  const [choice, setChoice] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void apiFetch('/api/me/profile')
      .then(async (response) =>
        response.ok ? profileResponseSchema.parse(await response.json()) : null,
      )
      .then(
        (profile) => active && setJobTitle(profile?.jobTitle ?? null),
        () => undefined,
      );
    return () => {
      active = false;
    };
  }, []);

  if (session.status === 'loading') {
    return (
      <AuthPage busy>
        <p>Loading…</p>
      </AuthPage>
    );
  }
  if (session.status !== 'active' && session.status !== 'pending') {
    return <Navigate to="/sign-in" replace />;
  }
  if (!session.me.positionSetupRequired) {
    return <Navigate to={session.status === 'pending' ? '/access-pending' : '/'} replace />;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!choice) {
      setError('Choose the position that best describes your work.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch('/api/me/position', {
        method: 'POST',
        body: JSON.stringify({ position: choice }),
      });
      // 409: already saved (e.g. in another tab); either way setup is complete.
      if (!response.ok && response.status !== 409) {
        setError('Your position wasn’t saved. Try again.');
        return;
      }
      await refresh();
      void navigate('/', { replace: true });
    } catch {
      setError('Your position wasn’t saved because the server could not be reached. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AuthPage wide>
      <div>
        <p className="auth-eyebrow">First sign-in</p>
        <h1>Welcome, {session.me.displayName}</h1>
        <p className="auth-lead">
          Choose your position. You do this once, and your work in Material Mule is attributed to
          you.
        </p>
      </div>
      <form className="position-form" onSubmit={(event) => void save(event)} noValidate>
        <fieldset className="position-options" aria-describedby="position-note">
          <legend>Your position</legend>
          {jobTitle ? <p className="field-hint">From Microsoft: {jobTitle}</p> : null}
          {POSITIONS.map((position) => (
            <label key={position} className="position-option">
              <input
                type="radio"
                name="position"
                value={position}
                checked={choice === position}
                onChange={() => setChoice(position)}
              />
              <span>
                <strong>{POSITION_LABELS[position].label}</strong>
                <span className="field-hint">{POSITION_LABELS[position].description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p id="position-note" className="auth-callout">
          Your position describes your work. It doesn’t grant access: an administrator approves
          access, and project authority comes from project assignments.
        </p>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="auth-actions auth-actions-end">
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </AuthPage>
  );
}
