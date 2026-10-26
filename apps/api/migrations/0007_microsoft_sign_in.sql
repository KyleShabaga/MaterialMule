-- TRP-T05: Microsoft sign-in and profile onboarding.
-- People are keyed on (tenant ID, object ID) in identity_link; everything on app_user below is
-- profile data that may change without creating a new user.

ALTER TABLE app_user
  ADD COLUMN job_title                      text CHECK (length(job_title) <= 200),
  ADD COLUMN department                     text CHECK (length(department) <= 200),
  ADD COLUMN office_location                text CHECK (length(office_location) <= 200),
  -- Where the profile fields last came from, and when they were last refreshed successfully.
  ADD COLUMN profile_source                 text
                                              CHECK (profile_source IN ('microsoft_graph', 'microsoft_id_token', 'seed')),
  ADD COLUMN profile_refreshed_at           timestamptz,
  -- Set when the latest refresh failed (the stored values are then the last known ones).
  ADD COLUMN profile_refresh_failed_at      timestamptz,
  -- First-login position choice: saved once, never set by a profile refresh, grants nothing.
  ADD COLUMN position_set_at                timestamptz,
  -- Official initials are confirmed by an admin (TRP-T07); refresh never writes them.
  ADD COLUMN initials_confirmed_by_user_id  uuid REFERENCES app_user (id),
  ADD COLUMN initials_confirmed_at          timestamptz,
  ADD CONSTRAINT app_user_position_set_has_position CHECK (position_set_at IS NULL OR position IS NOT NULL),
  ADD CONSTRAINT app_user_initials_confirmation_complete
    CHECK ((initials_confirmed_by_user_id IS NULL) = (initials_confirmed_at IS NULL));

-- A Microsoft identity is a tenant GUID plus an immutable object ID (oid) GUID, and a person has
-- at most one.
ALTER TABLE identity_link
  ADD CONSTRAINT identity_link_microsoft_shape CHECK (
    provider <> 'microsoft'
    OR (tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );
CREATE UNIQUE INDEX identity_link_one_microsoft_per_user
  ON identity_link (user_id) WHERE provider = 'microsoft';

-- In-flight Microsoft sign-ins (authorization-code flow with PKCE). Short-lived and single-use;
-- only hashes of the state and of the browser-binding cookie are stored.
CREATE TABLE oidc_sign_in_attempt (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              text NOT NULL CHECK (provider = 'microsoft'),
  state_hash            bytea NOT NULL UNIQUE,
  browser_binding_hash  bytea NOT NULL,
  nonce                 text NOT NULL,
  code_verifier         text NOT NULL,
  return_to             text NOT NULL
                          CHECK (return_to ~ '^/' AND return_to !~ '^//' AND length(return_to) <= 500),
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX oidc_sign_in_attempt_expires_idx ON oidc_sign_in_attempt (expires_at);
