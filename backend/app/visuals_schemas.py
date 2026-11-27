"""Request models for visuals edits and apply (M4 UI-B).

They mirror the engine's ``visuals-edit`` patch (youtube-agent D-123 @ 26c608f,
``agents/visuals_edit.py``): the same operations, fields, enums and limits, strict like the
engine (unknown fields, wrong JSON types and explicit nulls are errors). The engine validates
again, binds every clearance to the bytes and evidence it names, and is authoritative; this
layer only rejects malformed requests before any engine run, and NFC-normalises text so that
what is sent is what the engine stores.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.engine import commands

HEX64 = r"^[0-9a-f]{64}$"
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")  # newlines and tabs are kept

# The engine's limits (agents/visuals_edit.py): 200 operations, 20 shots per scene.
MAX_OPERATIONS = 200
MAX_SHOTS = 20
MOTIONS = ("static", "slow_zoom", "slow_zoom_out", "pan_left", "pan_right")
FITS = ("auto", "cover", "contain")
# visuals/models.py CLEARANCE_BASES and CLEARANCE_ACKNOWLEDGEMENT. The acknowledgement must be
# sent exactly; the real-engine integration test proves this copy is the engine's.
CLEARANCE_BASES = (
    "license_confirmed_at_source",
    "public_domain_confirmed",
    "permission_obtained",
    "own_work",
    "provider_terms_reviewed",
)
CLEARANCE_ACKNOWLEDGEMENT = (
    "I reviewed the source and licence of this exact image and take responsibility for this "
    "rights decision. The tool did not verify it and it is not legal advice."
)

SceneId = Annotated[str, Field(pattern=commands.SCENE_ID_RE.pattern)]
CandidateId = Annotated[str, Field(pattern=commands.CANDIDATE_ID_RE.pattern)]
Sha = Annotated[str, Field(pattern=HEX64)]
Reviewer = Annotated[str, Field(min_length=1, max_length=200)]


def _clean(v: object) -> object:
    if isinstance(v, str):
        if _CONTROL.search(v):
            raise ValueError("contains control characters")
        return unicodedata.normalize("NFC", v)
    return v


class _Op(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        nulls = sorted(k for k, v in value.items() if v is None)
        if nulls:
            raise ValueError(f"null is not allowed ({', '.join(nulls)}); omit a field instead")
        return {k: _clean(v) for k, v in value.items()}


class ShotIn(_Op):
    candidate_id: CandidateId
    motion: Literal["static", "slow_zoom", "slow_zoom_out", "pan_left", "pan_right"] | None = None
    fit: Literal["auto", "cover", "contain"] | None = None
    duration_seconds: float | None = Field(default=None, gt=0, le=600)


class ShotsSet(_Op):
    op: Literal["shots.set"]
    scene_id: SceneId
    shots: Annotated[list[ShotIn], Field(min_length=1, max_length=MAX_SHOTS)]


class ShotsClear(_Op):
    op: Literal["shots.clear"]
    scene_id: SceneId


class ClearanceSet(_Op):
    op: Literal["clearance.set"]
    candidate_id: CandidateId
    expected_candidate_sha256: Sha
    expected_rights_fingerprint: Sha
    reviewer: Reviewer
    basis: Literal[
        "license_confirmed_at_source", "public_domain_confirmed", "permission_obtained",
        "own_work", "provider_terms_reviewed",
    ]  # fmt: skip
    justification: Annotated[str, Field(min_length=1, max_length=4000)]
    evidence: Annotated[str, Field(min_length=1, max_length=2000)]
    acknowledgement: Annotated[str, Field(min_length=1, max_length=500)]


class ClearanceRevoke(_Op):
    op: Literal["clearance.revoke"]
    candidate_id: CandidateId
    reviewer: Reviewer
    reason: Annotated[str, Field(min_length=1, max_length=4000)]


class PlanUpdate(_Op):
    op: Literal["plan.update"]
    scene_id: SceneId
    search_query: Annotated[str, Field(max_length=300)] | None = None
    search_enabled: bool | None = None
    generation_enabled: bool | None = None
    notes: Annotated[str, Field(max_length=2000)] | None = None


Operation = Annotated[
    ShotsSet | ShotsClear | ClearanceSet | ClearanceRevoke | PlanUpdate,
    Field(discriminator="op"),
]


class VisualsEditRequest(BaseModel):
    # Strict like the operations: a JSON string is never coerced into the boolean ``dry_run``.
    model_config = ConfigDict(extra="forbid", strict=True)

    expected_revision: str = Field(pattern=HEX64)
    operations: Annotated[list[Operation], Field(min_length=1, max_length=MAX_OPERATIONS)]
    dry_run: bool = False

    def patch(self) -> dict[str, Any]:
        """The engine patch: every field the reviewer gave, none the model defaulted."""
        return {
            "operations": [op.model_dump(mode="json", exclude_unset=True) for op in self.operations]
        }


class VisualsApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    expected_revision: str = Field(pattern=HEX64)
    reviewer: Reviewer
    confirm: Literal[True]

    @field_validator("confirm", mode="before")
    @classmethod
    def _true(cls, v: object) -> object:
        if v is not True:  # 1 == True in Python: only the JSON boolean true confirms
            raise ValueError("confirm must be the JSON boolean true")
        return v
