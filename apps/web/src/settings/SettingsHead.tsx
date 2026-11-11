import type { ReactNode } from 'react';

/**
 * The head of every settings page (docs/redesign/design.md, "Settings pages"): its title, a
 * one-line statement of who can change it, and its actions at the top right, over a 2 px rule.
 * `id` names the page's section (`aria-labelledby`), so existing headings keep their names.
 */
export function SettingsHead({
  id,
  title,
  who,
  actions,
}: {
  id: string;
  title: ReactNode;
  /** e.g. "Everyone can read this; Lab Managers change it." */
  who?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="settings-head">
      <div className="settings-head-titles">
        <h2 id={id}>{title}</h2>
        {who ? <p className="settings-who">{who}</p> : null}
      </div>
      {actions ? <div className="settings-head-actions">{actions}</div> : null}
    </div>
  );
}

/** A sub-section heading inside a settings page: h3 and an optional mono meta over the rule. */
export function SettingsSub({
  id,
  title,
  meta,
}: {
  id?: string;
  title: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="settings-sub">
      <h3 id={id}>{title}</h3>
      {meta ? <span className="section-meta">{meta}</span> : null}
    </div>
  );
}
