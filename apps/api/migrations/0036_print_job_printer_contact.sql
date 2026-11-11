-- Review fixes (PRs #119, #124): the printer's own contact history, kept apart from how the job
-- ended.
--
-- System status read the printer's health from the job as a whole: its status, created_at and
-- updated_at, and the failure kind of its label.print_failed entry. Two things went wrong:
--
-- - #124: a job whose retry was refused locally (its unit disposed, its label unpreparable) lost
--   the connection refusal of its earlier attempt, so the dashboard fell back to an older success.
-- - #119: a failure period was measured from the job's created_at, so time spent waiting in the
--   queue counted as time the printer was failing.
--
-- The worker now records each attempt that actually reached for the printer (a transport send,
-- or a send interrupted by a restart) on the job: when, the result, the error and the printer's
-- own status message. A preparation refusal leaves these untouched. first_failed_contact_at is the
-- job's first unsuccessful contact; a job ends at its first success, so per printer (whose queue
-- runs one job at a time, in order) a failure sequence starts at the first such time after the
-- printer's last success.

ALTER TABLE print_job
  ADD COLUMN last_contact_at timestamptz,
  ADD COLUMN last_contact_result text
    CONSTRAINT print_job_last_contact_result_check
    CHECK (last_contact_result IN ('sent', 'not_sent', 'uncertain')),
  ADD COLUMN last_contact_error text
    CONSTRAINT print_job_last_contact_error_length_check CHECK (length(last_contact_error) <= 500),
  ADD COLUMN last_contact_printer_message text
    CONSTRAINT print_job_last_contact_printer_message_check
    CHECK (length(last_contact_printer_message) <= 200),
  ADD COLUMN first_failed_contact_at timestamptz;

-- Backfill what the old summary read as a printer attempt (the best the stored data can say):
-- a tried job that was sent, is waiting to retry, is uncertain and unconfirmed, or failed with the
-- printer contacted. Its one known time stands for both the last and the first failed contact.
UPDATE print_job j
   SET last_contact_at = coalesce(j.sent_at, j.updated_at),
       last_contact_result = CASE j.status WHEN 'sent' THEN 'sent'
                                           WHEN 'uncertain' THEN 'uncertain'
                                           ELSE 'not_sent' END,
       last_contact_error = CASE WHEN j.status <> 'sent' THEN j.last_error END,
       last_contact_printer_message = CASE WHEN j.status <> 'sent' THEN j.printer_message END,
       first_failed_contact_at = CASE WHEN j.status <> 'sent' THEN j.updated_at END
 WHERE j.attempts > 0
   AND (j.status IN ('sent', 'queued')
        OR (j.status = 'uncertain' AND j.physically_confirmed_at IS NULL)
        OR (j.status = 'failed'
            AND (SELECT a.after_values->>'failure'
                   FROM audit_event a
                  WHERE a.entity_type = 'print_job' AND a.entity_id = j.id
                    AND a.action = 'label.print_failed'
                  ORDER BY a.occurred_at DESC
                  LIMIT 1) = 'printer'));

-- A contact has a time and a result, or neither; a successful contact carries no error; a failed
-- contact sequence starts no later than the last contact.
ALTER TABLE print_job
  ADD CONSTRAINT print_job_last_contact_shape CHECK (
    (last_contact_at IS NULL) = (last_contact_result IS NULL)
    AND (last_contact_result IS DISTINCT FROM 'sent'
         OR (last_contact_error IS NULL AND last_contact_printer_message IS NULL))
    AND (first_failed_contact_at IS NULL
         OR (last_contact_at IS NOT NULL AND first_failed_contact_at <= last_contact_at))
  );
