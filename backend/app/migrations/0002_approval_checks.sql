-- M2: engine approvals the UI could not confirm cover the version the reviewer validated.
-- A row means "the engine's current review.json record (by digest) is NOT the reviewer's
-- confirmed approval"; it is cleared when a later approval request confirms that version.
-- UI metadata only: the engine's review.json stays authoritative and is never written here.

CREATE TABLE approval_mismatches (
    project_id     TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    record_digest  TEXT NOT NULL,
    created_at     TEXT NOT NULL
);
