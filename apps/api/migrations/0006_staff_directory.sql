-- TRP-T07 (0006): staff directory, approval and pre-provisioning.
-- Initials stay non-unique (two "JS" staff are two people); only an expected UPN identifies a
-- pre-provisioned entry, and only until that person's first Microsoft sign-in links it.

ALTER TABLE app_user
  -- Work email / UPN an admin expects this person to sign in with. Compared case-insensitively
  -- (Entra UPNs are case-insensitive); never matched on initials or name.
  ADD COLUMN expected_upn     text CHECK (expected_upn = btrim(expected_upn)
                                          AND length(expected_upn) BETWEEN 3 AND 320
                                          AND expected_upn ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  ADD COLUMN approved_by      uuid REFERENCES app_user (id),
  ADD COLUMN approved_at      timestamptz,
  ADD COLUMN disabled_reason  text CHECK (length(btrim(disabled_reason)) BETWEEN 1 AND 2000),
  -- Approval is recorded together: who and when.
  ADD CONSTRAINT app_user_approval_pair_check
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  -- A disable reason belongs only to a disabled account; re-enabling clears it (the audit keeps it).
  ADD CONSTRAINT app_user_disabled_reason_status_check
    CHECK (disabled_reason IS NULL OR status = 'disabled');

CREATE UNIQUE INDEX app_user_expected_upn_key
  ON app_user (lower(expected_upn)) WHERE expected_upn IS NOT NULL;

-- Receiver search filters active staff by initials; names use a lower() scan (small table).
CREATE INDEX app_user_status_initials_idx ON app_user (status, official_initials);
