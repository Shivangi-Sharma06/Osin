from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .config import get_settings


def _connect() -> sqlite3.Connection:
    settings = get_settings()
    path = Path(settings.database_path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key in ("raw_profile_json", "explanation_json"):
        if key in data and isinstance(data[key], str):
            data[key] = json.loads(data[key])
    return data


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [row_to_dict(row) or {} for row in rows]


def init_db() -> None:
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS entities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL CHECK (type IN ('person', 'domain')),
                canonical_name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS identifiers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_id INTEGER NOT NULL,
                platform TEXT NOT NULL,
                handle TEXT NOT NULL,
                value TEXT,
                first_observed TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_observed TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                raw_profile_json TEXT NOT NULL DEFAULT '{}',
                source_url TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'github_api',
                collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
                UNIQUE(platform, handle)
            );

            CREATE TABLE IF NOT EXISTS evidence_signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                identifier_id_a INTEGER NOT NULL,
                identifier_id_b INTEGER NOT NULL,
                signal_type TEXT NOT NULL CHECK (
                    signal_type IN (
                        'username_similarity',
                        'face_match',
                        'bio_similarity',
                        'mutual_connections',
                        'location_match',
                        'email_hash_match',
                        'employer_match',
                        'timezone_match'
                    )
                ),
                raw_score REAL NOT NULL,
                weight REAL NOT NULL,
                contributes_to_confidence REAL NOT NULL,
                notes TEXT NOT NULL,
                FOREIGN KEY (identifier_id_a) REFERENCES identifiers(id) ON DELETE CASCADE,
                FOREIGN KEY (identifier_id_b) REFERENCES identifiers(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS match_clusters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_id INTEGER NOT NULL UNIQUE,
                confidence_score REAL NOT NULL,
                computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                explanation_json TEXT NOT NULL,
                FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                identifier_id INTEGER NOT NULL,
                captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                field_changed TEXT NOT NULL,
                old_value TEXT,
                new_value TEXT,
                source TEXT NOT NULL CHECK (source IN ('live', 'wayback')),
                FOREIGN KEY (identifier_id) REFERENCES identifiers(id) ON DELETE CASCADE
            );
            """
        )

