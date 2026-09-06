from typing import Any, Literal

from pydantic import BaseModel, Field


LookupScope = Literal["self_audit", "consented", "public_figure"]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=80)
    lookup_scope: LookupScope = "self_audit"


class ExplanationItem(BaseModel):
    signal_type: str
    points: float
    human_readable_reason: str
    raw_score: float
    weight: float


class SearchResponse(BaseModel):
    entity: dict[str, Any]
    identifiers: list[dict[str, Any]]
    cluster: dict[str, Any]
    graph: dict[str, Any]

