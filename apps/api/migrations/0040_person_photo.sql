-- STRATA-52 (decision STRATA-53): directory photos for avatars, cached on the host.
--
-- The server reads a person's Microsoft photo at sign-in and profile refresh, checks it (JPEG or
-- PNG by its bytes, 100 KB at most) and keeps one copy per person here, so avatars work without
-- the internet and browsers never talk to Graph. GET /api/people/:userId/photo serves it.

CREATE TABLE person_photo (
  user_id       uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
  content_type  text NOT NULL
                  CONSTRAINT person_photo_content_type_check
                  CHECK (content_type IN ('image/jpeg', 'image/png')),
  bytes         bytea NOT NULL
                  -- PERSON_PHOTO_MAX_BYTES (packages/shared/src/people.ts).
                  CONSTRAINT person_photo_size_check
                  CHECK (octet_length(bytes) BETWEEN 1 AND 102400),
  sha256        text NOT NULL
                  CONSTRAINT person_photo_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  -- The stored type matches the bytes: JPEG starts FF D8 FF, PNG with its 8-byte signature.
  CONSTRAINT person_photo_magic_check CHECK (
    (content_type = 'image/jpeg' AND substring(bytes FROM 1 FOR 3) = '\xffd8ff'::bytea)
    OR (content_type = 'image/png'
        AND substring(bytes FROM 1 FOR 8) = '\x89504e470d0a1a0a'::bytea)
  ),
  -- The digest is of the stored bytes (the photo route's ETag).
  CONSTRAINT person_photo_sha256_matches CHECK (sha256 = encode(sha256(bytes), 'hex'))
);

-- A disabled person keeps no photo: none can be saved for them ...
CREATE FUNCTION person_photo_owner_not_disabled() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_user WHERE id = NEW.user_id AND status = 'disabled') THEN
    RAISE EXCEPTION 'person_photo: % is disabled', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'person_photo_owner_not_disabled';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER person_photo_owner_not_disabled
  BEFORE INSERT OR UPDATE ON person_photo
  FOR EACH ROW EXECUTE FUNCTION person_photo_owner_not_disabled();

-- ... and disabling them deletes the one they had, in the same transaction.
CREATE FUNCTION person_photo_delete_on_disable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM person_photo WHERE user_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER person_photo_delete_on_disable
  AFTER UPDATE OF status ON app_user
  FOR EACH ROW WHEN (NEW.status = 'disabled' AND OLD.status IS DISTINCT FROM 'disabled')
  EXECUTE FUNCTION person_photo_delete_on_disable();
