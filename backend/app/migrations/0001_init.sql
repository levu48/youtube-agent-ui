-- UI-owned metadata only. Engine stage state is never duplicated here.

CREATE TABLE projects (
    id            TEXT PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    root_path     TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE jobs (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects(id),
    job_type           TEXT NOT NULL,
    status             TEXT NOT NULL,
    command_args_json  TEXT NOT NULL,
    pid                INTEGER,
    process_started    TEXT,
    created_at         TEXT NOT NULL,
    started_at         TEXT,
    finished_at        TEXT,
    exit_code          INTEGER,
    message            TEXT,
    error_message      TEXT,
    error_code         TEXT,
    cancel_requested   INTEGER NOT NULL DEFAULT 0,
    log_path           TEXT
);

CREATE INDEX idx_jobs_project ON jobs(project_id, created_at);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_created ON jobs(created_at);

CREATE TABLE job_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        TEXT NOT NULL REFERENCES jobs(id),
    event_type    TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE INDEX idx_job_events_job ON job_events(job_id, id);
