-- Reference data for every environment, including production. Idempotent.
-- Production otherwise starts empty: no projects, no users (D42).

INSERT INTO location (code, name, kind, is_system, active)
VALUES ('RECEIVING', 'Receiving lab', 'receiving_lab', true, true)
ON CONFLICT (code_normalized) DO NOTHING;
