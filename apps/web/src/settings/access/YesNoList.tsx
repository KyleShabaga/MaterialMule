import type { ReactNode } from 'react';
import { StatusBadge } from '../../components/app-ui';
import '../settings.css';

export interface YesNoItem {
  key: string;
  yes: boolean;
  what: ReactNode;
  note?: ReactNode;
}

/**
 * A YES / NO list of what an account can do (canvas SettingsAccess, ProjectTeam). It only shows
 * what the server reported; it never decides anything, and the server checks every action again.
 */
export function YesNoList({ label, items }: { label: string; items: readonly YesNoItem[] }) {
  return (
    <ul className="yes-no-list" aria-label={label}>
      {items.map((item) => (
        <li key={item.key} data-row="1">
          <StatusBadge tone={item.yes ? 'storage' : 'closed'}>
            {item.yes ? 'Yes' : 'No'}
          </StatusBadge>
          <span className="yes-no-text">
            <span className="yes-no-what">{item.what}</span>
            {item.note ? <span className="yes-no-note">{item.note}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
