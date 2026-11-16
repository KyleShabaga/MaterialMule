-- STRATA-25 (Strata redesign, lane 1C): each person's read state for action requests in the
-- single Inbox feed. Updates (notifications) keep their own read_at / dismissed_at; requests had
-- none, because an action request is shared work routed to several people.
--
-- One row per (person, request), written only when the person reads it, marks it unread again
-- or reads everything ("Mark all read"). No row means the default: unread for someone the request
-- is routed to (so a request reassigned or rerouted to someone new arrives unread for them), read
-- for the person who raised it. `read_at` null is an explicit "mark unread".
--
-- Reading never resolves a request: this table has no link back into action_item's state, and
-- nothing here touches action_item, its routing, its notifications' identity or the audit log.

CREATE TABLE inbox_request_read (
  user_id         uuid NOT NULL REFERENCES app_user (id),
  action_item_id  uuid NOT NULL REFERENCES action_item (id),
  read_at         timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_request_read_pkey PRIMARY KEY (user_id, action_item_id)
);
CREATE INDEX inbox_request_read_item_idx ON inbox_request_read (action_item_id);

-- Only active personal (or test) accounts have an Inbox: never LAB, never a disabled account.
-- The same rule as notification_recipient_check.
CREATE FUNCTION inbox_request_read_reader_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_user u
    WHERE u.id = NEW.user_id AND u.status = 'active'
      AND u.account_type IN ('personal', 'test')
  ) THEN
    RAISE EXCEPTION 'inbox read state belongs to active personal accounts only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'inbox_request_read_reader_check';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbox_request_read_reader_check
  BEFORE INSERT ON inbox_request_read
  FOR EACH ROW EXECUTE FUNCTION inbox_request_read_reader_check();

-- Rows are never deleted or moved to another person or request: only the read state changes.
CREATE FUNCTION inbox_request_read_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'inbox read state can''t be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.action_item_id IS DISTINCT FROM OLD.action_item_id THEN
    RAISE EXCEPTION 'inbox read state can only be read or unread'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inbox_request_read_guard
  BEFORE UPDATE OR DELETE ON inbox_request_read
  FOR EACH ROW EXECUTE FUNCTION inbox_request_read_guard();
CREATE TRIGGER inbox_request_read_no_truncate
  BEFORE TRUNCATE ON inbox_request_read
  FOR EACH STATEMENT EXECUTE FUNCTION inbox_request_read_guard();
