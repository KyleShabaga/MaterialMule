import { BandedCard } from '../components/ui';
import { useMe } from '../session/context';

/**
 * Settings → My profile → Notifications (MM-T27). Personal accounts only: the card isn't shown
 * for LAB, which has no inbox of its own.
 *
 * MISC-11: the "Email me" opt-in was removed from this card. The stored preference and the email
 * delivery code are kept (GET/PUT /api/me/notification-preferences still work); only the control
 * and its explanations are gone.
 */
export function NotificationPreferencesCard() {
  const me = useMe();
  if (!me.permissions.includes('action_item.read')) return null;
  return (
    <BandedCard
      className="profile-card"
      title="Notifications"
      subtitle="Action requests always appear under Pending actions at the top of the page."
    />
  );
}
