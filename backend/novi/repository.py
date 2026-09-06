from __future__ import annotations

import json
from typing import Any

from .db import get_db, row_to_dict, rows_to_dicts


SNAPSHOT_FIELDS = ("name", "bio", "company", "location", "blog", "twitter_username")


def upsert_github_profile(profile: dict[str, Any], query: str) -> dict[str, Any]:
    login = profile["login"]
    canonical = profile.get("name") or login
    source_url = profile.get("html_url") or f"https://github.com/{login}"

    with get_db() as db:
        existing_identifier = db.execute(
            "SELECT * FROM identifiers WHERE platform = ? AND handle = ?",
            ("github", login.lower()),
        ).fetchone()

        if existing_identifier:
            identifier = row_to_dict(existing_identifier) or {}
            entity_id = identifier["entity_id"]
            old_raw = identifier.get("raw_profile_json") or {}
            for field in SNAPSHOT_FIELDS:
                old_value = old_raw.get(field)
                new_value = profile.get(field)
                if old_value != new_value:
                    db.execute(
                        """
                        INSERT INTO snapshots(identifier_id, field_changed, old_value, new_value, source)
                        VALUES (?, ?, ?, ?, 'live')
                        """,
                        (identifier["id"], field, _stringify(old_value), _stringify(new_value)),
                    )

            db.execute(
                """
                UPDATE identifiers
                SET last_observed = CURRENT_TIMESTAMP,
                    raw_profile_json = ?,
                    source_url = ?,
                    source = 'github_api',
                    collected_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (json.dumps(profile), source_url, identifier["id"]),
            )
            db.execute(
                "UPDATE entities SET canonical_name = ? WHERE id = ?",
                (canonical, entity_id),
            )
        else:
            cursor = db.execute(
                "INSERT INTO entities(type, canonical_name) VALUES ('person', ?)",
                (canonical,),
            )
            entity_id = cursor.lastrowid
            db.execute(
                """
                INSERT INTO identifiers(entity_id, platform, handle, value, raw_profile_json, source_url, source)
                VALUES (?, 'github', ?, ?, ?, ?, 'github_api')
                """,
                (entity_id, login.lower(), login, json.dumps(profile), source_url),
            )

        entity = row_to_dict(db.execute("SELECT * FROM entities WHERE id = ?", (entity_id,)).fetchone()) or {}
        identifiers = rows_to_dicts(db.execute("SELECT * FROM identifiers WHERE entity_id = ?", (entity_id,)).fetchall())

    return {"entity": entity, "identifiers": identifiers}


def replace_cluster(entity_id: int, identifier_id: int, explanations: list[dict[str, Any]], confidence: float) -> dict[str, Any]:
    with get_db() as db:
        db.execute("DELETE FROM evidence_signals WHERE identifier_id_a = ? AND identifier_id_b = ?", (identifier_id, identifier_id))
        for item in explanations:
            db.execute(
                """
                INSERT INTO evidence_signals(
                    identifier_id_a,
                    identifier_id_b,
                    signal_type,
                    raw_score,
                    weight,
                    contributes_to_confidence,
                    notes
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identifier_id,
                    identifier_id,
                    item["signal_type"],
                    item["raw_score"],
                    item["weight"],
                    item["points"],
                    item["human_readable_reason"],
                ),
            )

        db.execute(
            """
            INSERT INTO match_clusters(entity_id, confidence_score, explanation_json)
            VALUES (?, ?, ?)
            ON CONFLICT(entity_id) DO UPDATE SET
                confidence_score = excluded.confidence_score,
                computed_at = CURRENT_TIMESTAMP,
                explanation_json = excluded.explanation_json
            """,
            (entity_id, confidence, json.dumps(explanations)),
        )
        cluster = row_to_dict(db.execute("SELECT * FROM match_clusters WHERE entity_id = ?", (entity_id,)).fetchone()) or {}
    return cluster


def get_cluster(entity_id: int) -> dict[str, Any] | None:
    with get_db() as db:
        return row_to_dict(db.execute("SELECT * FROM match_clusters WHERE entity_id = ?", (entity_id,)).fetchone())


def get_entity(entity_id: int) -> dict[str, Any] | None:
    with get_db() as db:
        return row_to_dict(db.execute("SELECT * FROM entities WHERE id = ?", (entity_id,)).fetchone())


def get_identifiers(entity_id: int) -> list[dict[str, Any]]:
    with get_db() as db:
        return rows_to_dicts(db.execute("SELECT * FROM identifiers WHERE entity_id = ?", (entity_id,)).fetchall())


def get_graph(entity_id: int, depth: int = 1, include_low_confidence: bool = False) -> dict[str, Any]:
    depth = max(0, min(depth, 2))
    with get_db() as db:
        entity = row_to_dict(db.execute("SELECT * FROM entities WHERE id = ?", (entity_id,)).fetchone())
        if not entity:
            return {"nodes": [], "edges": []}

        identifiers = rows_to_dicts(db.execute("SELECT * FROM identifiers WHERE entity_id = ?", (entity_id,)).fetchall())
        cluster = row_to_dict(db.execute("SELECT * FROM match_clusters WHERE entity_id = ?", (entity_id,)).fetchone())

        nodes = [
            {
                "id": f"entity:{entity['id']}",
                "kind": "entity",
                "label": entity["canonical_name"],
                "entity_id": entity["id"],
                "confidence": cluster["confidence_score"] if cluster else 0,
            }
        ]
        edges = []

        if depth >= 1:
            for identifier in identifiers[:35]:
                nodes.append(
                    {
                        "id": f"identifier:{identifier['id']}",
                        "kind": "identifier",
                        "label": f"{identifier['platform']}:{identifier['handle']}",
                        "platform": identifier["platform"],
                        "handle": identifier["handle"],
                        "source_url": identifier["source_url"],
                        "entity_id": entity["id"],
                        "raw_profile_json": identifier["raw_profile_json"],
                    }
                )
                score = cluster["confidence_score"] if cluster else 0
                if include_low_confidence or score >= 40:
                    edges.append(
                        {
                            "id": f"entity:{entity['id']}->identifier:{identifier['id']}",
                            "source": f"entity:{entity['id']}",
                            "target": f"identifier:{identifier['id']}",
                            "confidence": score,
                            "label": "collected identifier",
                        }
                    )

        return {"nodes": nodes[:40], "edges": edges}


def _stringify(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)

