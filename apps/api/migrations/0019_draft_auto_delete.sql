-- TRP-T40: draft auto-delete setting.
--
-- Receiving drafts live only in each browser (TRP-T11). This one-row table says whether browsers
-- delete their own drafts that haven't been saved for `after_days` days. Off by default; Admin and
-- Lab Manager change it through PUT /api/settings/drafts (optimistic `version`, audited as
-- settings.drafts_changed). The browser does the deleting; the server never sees drafts.

CREATE TABLE draft_auto_delete_setting (
  -- Exactly one row: the primary key can only be true.
  singleton           boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled             boolean NOT NULL DEFAULT false,
  after_days          integer NOT NULL DEFAULT 90 CHECK (after_days BETWEEN 30 AND 365),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid REFERENCES app_user (id)
);

INSERT INTO draft_auto_delete_setting DEFAULT VALUES;
