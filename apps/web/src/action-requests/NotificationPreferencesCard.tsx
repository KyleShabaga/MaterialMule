import type { NotificationPreferences } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { BandedCard } from '../components/ui';
import { fetchPreferences, savePreferences } from './api';

/**
 * Settings → My profile → Notifications (MM-T27). Email for action requests only, off by default.
 * Routine moves, receipts, comments and test progress never send email. Sending itself stays off
 * for everyone until IT approves it; the choice is still saved. Personal accounts only: the card
 * isn't shown for LAB, which has no preferences of its own.
 */
export function NotificationPreferencesCard() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchPreferences().then((loaded) => {
      if (active) setPrefs(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!prefs) return null;

  async function change(on: boolean) {
    if (!prefs) return;
    setBusy(true);
    setNotice(null);
    const saved = await savePreferences(on, prefs.version);
    setBusy(false);
    if (saved === 'stale') {
      setNotice('Your preferences changed in another window. The latest are shown.');
      setPrefs(await fetchPreferences());
    } else if (saved === 'error') {
      setNotice('Your preference couldn’t be saved. Try again.');
    } else {
      setPrefs(saved);
      setNotice('Saved.');
    }
  }

  return (
    <BandedCard
      className="profile-card"
      title="Notifications"
      subtitle="Action requests always appear under the bell at the top of the page."
    >
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={prefs.emailActionRequests}
          disabled={busy}
          onChange={(event) => void change(event.target.checked)}
        />{' '}
        Email me when an action request needs my decision
      </label>
      <p className="field-hint">
        Only action requests are emailed, never moves, receipts, comments or test progress.
      </p>
      {!prefs.emailSendingEnabled ? (
        <p className="field-hint">
          Email sending is switched off for everyone until IT approves it. Your choice is saved and
          takes effect then.
        </p>
      ) : null}
      {!prefs.hasWorkEmail ? (
        <p className="field-hint">Your profile has no work email, so no email can be sent.</p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </BandedCard>
  );
}
