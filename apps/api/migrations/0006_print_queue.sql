-- TRP-T15: persistent Zebra print queue.
-- Printers are server-side configuration: clients only ever name a printer by its key, never a
-- host or port. Jobs keep honest status: a job is only `sent` when every byte was written and the
-- connection closed cleanly; anything ambiguous is `uncertain` and is never resent automatically.

CREATE TABLE printer (
  key           text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  -- IPv4 address or DNS host name; never accepted from a print request.
  host          text NOT NULL CHECK (host ~ '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'),
  port          integer NOT NULL DEFAULT 9100 CHECK (port BETWEEN 1 AND 65535),
  enabled       boolean NOT NULL DEFAULT true,
  -- Used when a print request names no printer. At most one.
  is_default    boolean NOT NULL DEFAULT false,
  -- Ask the printer for its host status (~HS) before sending labels.
  check_status  boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX printer_one_default_idx ON printer (is_default) WHERE is_default;

ALTER TABLE print_job
  ADD CONSTRAINT print_job_printer_fk FOREIGN KEY (printer_key) REFERENCES printer (key),
  -- Earliest time the worker may (re)try a queued job (retry backoff after a safe failure).
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- Plain-language printer condition from host status, e.g. "Printer out of labels".
  ADD COLUMN printer_message text CHECK (length(printer_message) <= 200),
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN physically_confirmed_by_user_id uuid REFERENCES app_user (id),
  ADD CONSTRAINT print_job_last_error_length_check CHECK (length(last_error) <= 500),
  -- Retries stop at three attempts.
  ADD CONSTRAINT print_job_attempts_max_check CHECK (attempts <= 3),
  ADD CONSTRAINT print_job_sent_at_check CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  -- A person can only confirm labels came out for a job that sent (or may have sent) bytes.
  ADD CONSTRAINT print_job_physical_confirmation_check CHECK (
    (physically_confirmed_at IS NULL AND physically_confirmed_by_user_id IS NULL)
    OR (physically_confirmed_at IS NOT NULL AND physically_confirmed_by_user_id IS NOT NULL
        AND status IN ('sent', 'uncertain'))
  );

DROP INDEX print_job_status_idx;
CREATE INDEX print_job_queue_idx ON print_job (printer_key, status, created_at);
CREATE INDEX print_job_status_idx ON print_job (status) WHERE status IN ('queued', 'sending');
