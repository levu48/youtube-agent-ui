"""UI record of engine approvals the reviewer did not confirm (see migration 0002).

The engine's review.json stays authoritative for *whether* a draft is approved. This table only
lets the UI refuse to present an approval as the reviewer's when it could not confirm that the
engine approved the exact version the reviewer validated."""

from __future__ import annotations

from app.db import Database, utcnow


class ApprovalChecks:
    def __init__(self, db: Database) -> None:
        self.db = db

    def mark_unconfirmed(self, project_id: str, digest: str) -> None:
        with self.db.tx() as c:
            c.execute(
                "INSERT INTO approval_mismatches(project_id, record_digest, created_at) "
                "VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET "
                "record_digest = excluded.record_digest, created_at = excluded.created_at",
                (project_id, digest, utcnow()),
            )

    def clear(self, project_id: str) -> None:
        with self.db.tx() as c:
            c.execute("DELETE FROM approval_mismatches WHERE project_id = ?", (project_id,))

    def is_unconfirmed(self, project_id: str, digest: str | None) -> bool:
        if digest is None:
            return False
        row = self.db.query_one(
            "SELECT record_digest FROM approval_mismatches WHERE project_id = ?", (project_id,)
        )
        return bool(row) and row["record_digest"] == digest
