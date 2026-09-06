from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .collectors import CollectorDisabledError, collect_github_user
from .db import init_db
from .repository import get_cluster, get_entity, get_graph, get_identifiers, replace_cluster, upsert_github_profile
from .schemas import SearchRequest, SearchResponse
from .scoring import build_github_explanations, confidence_from_explanations

app = FastAPI(title="novi API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "app": "novi"}


@app.post("/api/search", response_model=SearchResponse)
async def search(request: SearchRequest) -> dict:
    query = request.query.strip().lstrip("@")
    if not query:
        raise HTTPException(status_code=400, detail="Enter a GitHub handle to audit.")

    try:
        profile = await collect_github_user(query)
    except CollectorDisabledError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GitHub collector failed: {exc}") from exc

    stored = upsert_github_profile(profile, query)
    identifier = next(item for item in stored["identifiers"] if item["platform"] == "github")
    explanations = build_github_explanations(profile, query)
    confidence = confidence_from_explanations(explanations)
    cluster = replace_cluster(stored["entity"]["id"], identifier["id"], explanations, confidence)
    graph = get_graph(stored["entity"]["id"], depth=0)

    return {
        "entity": stored["entity"],
        "identifiers": stored["identifiers"],
        "cluster": cluster,
        "graph": graph,
    }


@app.get("/api/entity/{entity_id}/graph")
def graph(
    entity_id: int,
    depth: int = Query(default=1, ge=0, le=2),
    include_low_confidence: bool = False,
) -> dict:
    entity = get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found.")
    return get_graph(entity_id, depth=depth, include_low_confidence=include_low_confidence)


@app.get("/api/entity/{entity_id}")
def entity_detail(entity_id: int) -> dict:
    entity = get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found.")
    return {
        "entity": entity,
        "identifiers": get_identifiers(entity_id),
        "cluster": get_cluster(entity_id),
    }

