"""Request models for research edits, document imports and narration attestation (M3 UI-B).

They mirror the engine's ``research-edit`` patch (youtube-agent D-119/D-120 @ fb6bffc,
``agents/research_edit.py``): the same operations, fields, enums and limits, strict like the
engine (unknown fields, wrong JSON types and explicit nulls are errors). The engine validates
again and is authoritative; this layer only rejects malformed requests before any engine run,
and NFC-normalises text so that what is sent is what the engine stores.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

HEX64 = r"^[0-9a-f]{64}$"
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

ClaimId = Annotated[str, Field(pattern=r"^clm-[a-z0-9-]{3,40}$")]
LinkId = Annotated[str, Field(pattern=r"^ev-[0-9a-f]{16}$")]
RecheckId = Annotated[str, Field(pattern=r"^rc-[0-9a-f]{16}$")]
SnapshotId = Annotated[str, Field(pattern=r"^snap-[0-9a-f]{16}$")]
SourceId = Annotated[str, Field(pattern=r"^(src-[0-9a-f]{12}|doc-[0-9a-f]{16})$")]
DocId = Annotated[str, Field(pattern=r"^doc-[0-9a-f]{16}$")]
SegmentId = Annotated[str, Field(pattern=r"^seg-[0-9a-f]{16}$")]
SceneId = Annotated[str, Field(min_length=1, max_length=200)]

Short = Annotated[str, Field(min_length=1, max_length=200)]
Query = Annotated[str, Field(min_length=1, max_length=300)]
Assertion = Annotated[str, Field(min_length=1, max_length=2000)]
Quote = Annotated[str, Field(min_length=1, max_length=2000)]
Long = Annotated[str, Field(min_length=1, max_length=4000)]
Lang = Annotated[str, Field(min_length=2, max_length=20)]
Occurrence = Annotated[int, Field(ge=1, le=10_000)]

ClaimKind = Literal["factual", "quotation", "quantitative", "interpretation", "editorial"]
ClaimFlag = Literal[
    "date", "number", "quotation", "attribution", "causation", "contested", "source_needed",
    "uncertain", "question", "named_subject",
]  # fmt: skip
ClaimStatus = Literal[
    "unverified", "supported_pending_review", "verified", "disputed", "insufficient",
    "editorial_nonfactual",
]  # fmt: skip
EvidenceRole = Literal["supports", "contradicts", "context", "mentions_only"]
SourceType = Literal["primary", "secondary", "encyclopedia", "opinion", "user_supplied", "unknown"]


def _nfc(v: object) -> object:
    if isinstance(v, str):
        if _CONTROL.search(v):
            raise ValueError("contains control characters")
        return unicodedata.normalize("NFC", v)
    if isinstance(v, list):
        return [_nfc(x) for x in v]
    return v


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="before")
    @classmethod
    def _clean(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        nulls = sorted(k for k, v in value.items() if v is None)
        if nulls:
            raise ValueError(f"null is not allowed ({', '.join(nulls)}); omit the field")
        return {k: _nfc(v) for k, v in value.items()}


# --------------------------------------------------------------------------- research-edit


class AnchorOffsets(_Strict):
    """An anchor at engine-reported offsets (an uncovered sentence from research-check)."""

    scene_id: SceneId
    start: Annotated[int, Field(ge=0)]
    end: Annotated[int, Field(gt=0)]


class AnchorExcerpt(_Strict):
    """An anchor by its text; the engine locates it in the scene narration."""

    scene_id: SceneId
    excerpt: Assertion
    occurrence: Occurrence | None = None


class TranslationIn(_Strict):
    snapshot_id: SnapshotId
    quote: Quote
    occurrence: Occurrence | None = None
    language: Lang
    speaker: Short
    equivalence_note: Long


class ClaimsUpdate(_Strict):
    op: Literal["claims.update"]
    id: ClaimId
    assertion: Assertion | None = None
    kind: ClaimKind | None = None
    flags: Annotated[list[ClaimFlag], Field(max_length=10)] | None = None
    contested: bool | None = None
    notes: Long | None = None
    search_queries: Annotated[list[Query], Field(max_length=10)] | None = None


class ClaimsAdd(_Strict):
    op: Literal["claims.add"]
    anchor: AnchorOffsets | AnchorExcerpt
    assertion: Assertion
    kind: ClaimKind
    flags: Annotated[list[ClaimFlag], Field(max_length=10)] | None = None
    contested: bool | None = None
    notes: Long | None = None
    search_queries: Annotated[list[Query], Field(max_length=10)] | None = None


class ClaimsRemove(_Strict):
    op: Literal["claims.remove"]
    id: ClaimId


class EvidenceAdd(_Strict):
    op: Literal["evidence.add"]
    claim_id: ClaimId
    snapshot_id: SnapshotId
    quote: Quote
    occurrence: Occurrence | None = None
    role: EvidenceRole
    explanation: Long
    source_type: SourceType | None = None
    evidence_root: Short | None = None
    is_translation: bool | None = None
    translator: Short | None = None
    original_language: Lang | None = None
    translation_of: TranslationIn | None = None


class EvidenceUpdate(_Strict):
    op: Literal["evidence.update"]
    link_id: LinkId
    role: EvidenceRole | None = None
    explanation: Long | None = None
    source_type: SourceType | None = None
    evidence_root: Short | None = None


class EvidenceSetTranslation(_Strict):
    op: Literal["evidence.set_translation"]
    link_id: LinkId
    translation_of: TranslationIn
    translator: Short | None = None
    original_language: Lang | None = None


class EvidenceClearTranslation(_Strict):
    op: Literal["evidence.clear_translation"]
    link_id: LinkId


class EvidenceRemove(_Strict):
    op: Literal["evidence.remove"]
    link_id: LinkId


class ReviewsSet(_Strict):
    """A reviewer's decision. The status is always explicit: there is no default, and the
    engine's suggestion is never used in its place."""

    op: Literal["reviews.set"]
    claim_id: ClaimId
    status: ClaimStatus
    reviewer: Short
    rationale: Long
    counterargument_summary: Long | None = None
    counter_search_done: bool | None = None
    contradiction_resolution: Long | None = None
    narration_qualifies_dispute: bool | None = None
    exceptional_primary_basis: Long | None = None


class ReviewsClear(_Strict):
    op: Literal["reviews.clear"]
    claim_id: ClaimId
    reviewer: Short
    reason: Long


class CompletenessSet(_Strict):
    op: Literal["completeness.set"]
    reviewer: Short
    statement: Long


class RechecksAdd(_Strict):
    op: Literal["source_rechecks.add"]
    source_id: SourceId
    cited_snapshot_id: SnapshotId
    expected_current_snapshot_id: SnapshotId
    claim_ids: Annotated[list[ClaimId], Field(min_length=1, max_length=200)]
    reviewer: Short
    rationale: Long


class RechecksUpdate(_Strict):
    op: Literal["source_rechecks.update"]
    recheck_id: RecheckId
    reviewer: Short
    claim_ids: Annotated[list[ClaimId], Field(min_length=1, max_length=200)] | None = None
    rationale: Long | None = None


class RechecksRemove(_Strict):
    op: Literal["source_rechecks.remove"]
    recheck_id: RecheckId
    reviewer: Short
    reason: Long


class AttestPrimary(_Strict):
    op: Literal["documents.attest_primary"]
    snapshot_id: SnapshotId
    reviewer: Short
    statement: Long


class RevokePrimary(_Strict):
    op: Literal["documents.revoke_primary"]
    snapshot_id: SnapshotId
    reviewer: Short
    reason: Long


class MigrateIds(_Strict):
    op: Literal["migrate_ids"]


class MigrateReviewFile(_Strict):
    op: Literal["migrate_review_file"]


Operation = Annotated[
    ClaimsUpdate
    | ClaimsAdd
    | ClaimsRemove
    | EvidenceAdd
    | EvidenceUpdate
    | EvidenceSetTranslation
    | EvidenceClearTranslation
    | EvidenceRemove
    | ReviewsSet
    | ReviewsClear
    | CompletenessSet
    | RechecksAdd
    | RechecksUpdate
    | RechecksRemove
    | AttestPrimary
    | RevokePrimary
    | MigrateIds
    | MigrateReviewFile,
    Field(discriminator="op"),
]


class ResearchEditRequest(_Strict):
    """One ``research-edit`` publication, based on the research revision the page loaded."""

    expected_revision: str = Field(pattern=HEX64)
    dry_run: bool = False
    operations: Annotated[list[Operation], Field(min_length=1, max_length=200)]

    def patch(self) -> dict[str, Any]:
        """The engine patch: each operation with only the fields the client set."""
        return {"operations": [op.model_dump(exclude_unset=True) for op in self.operations]}


# --------------------------------------------------------------------------- documents


class DocumentImportRequest(_Strict):
    """An offline document with this edition's provenance (engine D-120). There is no
    ``url`` field: an imported document is never a fetch target, and ``declared_url`` is
    data only."""

    expected_revision: str = Field(pattern=HEX64)
    title: Annotated[str, Field(min_length=1, max_length=300)]
    language: Annotated[str, Field(pattern=r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$")]
    citation: Annotated[str, Field(min_length=1, max_length=2000)]
    imported_by: Short
    edition: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    declared_url: Annotated[str, Field(min_length=9, max_length=2000)] | None = None
    original_published_at: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    license: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    note: Long | None = None
    new_version_of: DocId | None = None
    text: Annotated[str, Field(min_length=1, max_length=400_000)]

    @field_validator("title", "citation", "imported_by", "text")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be blank")
        return v


# --------------------------------------------------------------------------- narration


class NarrationAttestRequest(_Strict):
    expected_revision: str = Field(pattern=HEX64)
    reviewer: Short
    statement: Long
    segment_ids: Annotated[list[SegmentId], Field(min_length=1, max_length=500)]


class ProvenanceInitRequest(_Strict):
    expected_revision: str = Field(pattern=HEX64)
    confirm: Literal[True]


# --------------------------------------------------------------------------- G2, apply, export


class ResearchApproveRequest(_Strict):
    """G2. ``expected_revision`` is the revision the reviewer last validated; the engine
    refuses the approval if anything changed since."""

    expected_revision: str = Field(pattern=HEX64)
    reviewer: Short
    comment: Annotated[str, Field(min_length=1, max_length=2000)] | None = None
    confirm: Literal[True]


class ResearchApplyRequest(_Strict):
    expected_revision: str = Field(pattern=HEX64)
    confirm: Literal[True]


class ResearchExportRequest(_Strict):
    expected_revision: str = Field(pattern=HEX64)
