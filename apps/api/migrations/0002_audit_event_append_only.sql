-- TRP-T03: audit events are append-only.
-- A trigger (not only grants) enforces this, because the table owner bypasses grants. Fixing a
-- mistaken event means recording a new, correcting event.

CREATE FUNCTION audit_event_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_is_append_only();

-- Belt and braces for non-owner roles (the production API role, TRP-T20).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM PUBLIC;
