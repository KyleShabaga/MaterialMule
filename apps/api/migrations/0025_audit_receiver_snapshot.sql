-- MM-T56: audit events that credit a receiver keep the receiver's initials and name as they were
-- when the event happened, like the actor and the receipt already do. Renaming, re-initialling
-- or disabling the person later must not rewrite history.
--
-- Initials may be NULL: a print at a LAB station or a project can credit staff who have no
-- confirmed initials yet. The name is always there.
--
-- The pairing rule is NOT VALID: events written before this migration carry only
-- receiver_user_id and audit_event is append-only, so they can't be backfilled. PostgreSQL still
-- checks every new row. History falls back to the receipt's snapshot for those older events.

ALTER TABLE audit_event
  ADD COLUMN receiver_initials_snapshot text
    CONSTRAINT audit_event_receiver_initials_snapshot_check
    CHECK (receiver_initials_snapshot ~ '^[A-Z]{1,5}$'),
  ADD COLUMN receiver_name_snapshot text
    CONSTRAINT audit_event_receiver_name_snapshot_check
    CHECK (length(btrim(receiver_name_snapshot)) BETWEEN 1 AND 200);

ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_receiver_snapshot_required CHECK (
    CASE
      WHEN receiver_user_id IS NULL
        THEN receiver_initials_snapshot IS NULL AND receiver_name_snapshot IS NULL
      ELSE receiver_name_snapshot IS NOT NULL
    END
  ) NOT VALID;
