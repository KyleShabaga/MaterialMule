-- STRATA-108 (Strata lane B, STRATA-78): who started each receiving draft, so only that person or
-- a verified Lab Manager may delete it. Drafts themselves stay in the browser that saved them
-- (MM-T11): this registry holds immutable ownership metadata only, never a draft's contents.
--
-- One row per draft (the browser's draft UUID):
-- * account_user_id is the signed-in account that started it (the shared LAB account at a
--   station); starter_user_id is the person: a personal account itself, or the person picked at
--   the LAB station (attribution only, never their roles);
-- * the account, the starter and created_at never change; changing Received by never touches them;
-- * a deletion is recorded once (deleted_at, by account and person) and never changed or undone;
-- * a draft saved before this registry existed has no owner. Its deletion (by a Lab Manager only)
--   is recorded as a `legacy` row with no account and no starter: ownership is never invented.
-- Rows are never deleted.

CREATE TABLE receipt_draft_registry (
  draft_id                    uuid PRIMARY KEY,
  legacy                      boolean NOT NULL DEFAULT false,
  account_user_id             uuid REFERENCES app_user (id),
  starter_user_id             uuid REFERENCES app_user (id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz,
  deleted_by_account_user_id  uuid REFERENCES app_user (id),
  deleted_by_user_id          uuid REFERENCES app_user (id),
  CONSTRAINT receipt_draft_registry_owner_check CHECK (
    CASE WHEN legacy
      THEN account_user_id IS NULL AND starter_user_id IS NULL
      ELSE account_user_id IS NOT NULL AND starter_user_id IS NOT NULL
    END
  ),
  -- The three deletion facts come together, and a legacy row exists only as a deletion record.
  CONSTRAINT receipt_draft_registry_deletion_check CHECK (
    (deleted_at IS NULL AND deleted_by_account_user_id IS NULL AND deleted_by_user_id IS NULL
       AND NOT legacy)
    OR (deleted_at IS NOT NULL AND deleted_by_account_user_id IS NOT NULL
       AND deleted_by_user_id IS NOT NULL AND deleted_at >= created_at)
  )
);

CREATE INDEX receipt_draft_registry_account_idx ON receipt_draft_registry (account_user_id);

CREATE FUNCTION receipt_draft_registry_people_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_kind text;
  starter_kind text;
  deleter_account_kind text;
  deleter_kind text;
BEGIN
  IF NOT NEW.legacy THEN
    SELECT account_type INTO account_kind FROM app_user WHERE id = NEW.account_user_id;
    SELECT account_type INTO starter_kind FROM app_user WHERE id = NEW.starter_user_id;
    -- The starter is always a person, never the shared LAB account itself.
    IF starter_kind = 'shared_lab' THEN
      RAISE EXCEPTION 'a draft is started by a person, never by the LAB account'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_starter_check';
    END IF;
    -- A personal account starts drafts as itself; only a LAB station names another person.
    IF account_kind <> 'shared_lab' AND NEW.starter_user_id <> NEW.account_user_id THEN
      RAISE EXCEPTION 'a personal account starts drafts as itself'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_starter_check';
    END IF;
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    SELECT account_type INTO deleter_account_kind FROM app_user
      WHERE id = NEW.deleted_by_account_user_id;
    SELECT account_type INTO deleter_kind FROM app_user WHERE id = NEW.deleted_by_user_id;
    IF deleter_kind = 'shared_lab'
       OR (deleter_account_kind <> 'shared_lab'
           AND NEW.deleted_by_user_id <> NEW.deleted_by_account_user_id) THEN
      RAISE EXCEPTION 'a deletion is credited to a person: the account itself, or LAB''s pick'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_deleter_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER receipt_draft_registry_people
  BEFORE INSERT OR UPDATE ON receipt_draft_registry
  FOR EACH ROW EXECUTE FUNCTION receipt_draft_registry_people_check();

CREATE FUNCTION receipt_draft_registry_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipt draft registry rows are never deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_immutable_check';
  END IF;
  IF NEW.draft_id IS DISTINCT FROM OLD.draft_id
     OR NEW.legacy IS DISTINCT FROM OLD.legacy
     OR NEW.account_user_id IS DISTINCT FROM OLD.account_user_id
     OR NEW.starter_user_id IS DISTINCT FROM OLD.starter_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'who started a draft never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_immutable_check';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a draft''s deletion is recorded once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receipt_draft_registry_deleted_once_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER receipt_draft_registry_no_rewrite
  BEFORE UPDATE OR DELETE ON receipt_draft_registry
  FOR EACH ROW EXECUTE FUNCTION receipt_draft_registry_immutable();
