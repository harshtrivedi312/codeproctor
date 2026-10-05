"""Face matching for the identity check (FR-403, ADR 0004 sections 1-2, D-05).

Never an automatic rejection: every outcome is MATCH or MANUAL_REVIEW with a reason code.
Embeddings live in memory only and are never persisted, logged, or shown in repr.
"""

from worker.face.matcher import FaceMatcher, SelfieCache
from worker.face.types import FaceDecision, MatchResult, ReviewReason

__all__ = ["FaceDecision", "FaceMatcher", "MatchResult", "ReviewReason", "SelfieCache"]
