-- TRP-T06: operational shared receiving account LAB (App Idea §8).
-- LAB signs in with an app-managed password (provider local_lab), never a Microsoft account.

-- One password per shared (local) account. Only an Argon2id PHC string is stored; it records its
-- own cost, so the cost can rise later without a migration.
CREATE TABLE local_credential (
  user_id             uuid PRIMARY KEY REFERENCES app_user (id),
  password_hash       text NOT NULL
                        CHECK (password_hash ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid REFERENCES app_user (id)
);

-- Personal and test accounts never get an app-managed password.
CREATE FUNCTION local_credential_is_for_shared_lab() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.user_id AND account_type = 'shared_lab') THEN
    RAISE EXCEPTION 'local_credential is only for shared_lab accounts'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER local_credential_shared_lab_only
  BEFORE INSERT OR UPDATE ON local_credential
  FOR EACH ROW EXECUTE FUNCTION local_credential_is_for_shared_lab();

-- Brute-force protection for local sign-in: failures per key (the account and the client
-- address) within a window, and a temporary lockout once the limit is reached.
CREATE TABLE sign_in_throttle (
  throttle_key       text PRIMARY KEY CHECK (length(throttle_key) BETWEEN 1 AND 200),
  failed_count       integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  locked_until       timestamptz
);
