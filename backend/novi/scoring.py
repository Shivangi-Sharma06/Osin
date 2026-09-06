from __future__ import annotations

import math
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Any


def _normalize_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def _tokens(value: str | None) -> Counter[str]:
    words = re.findall(r"[a-z0-9]+", _normalize_text(value))
    return Counter(words)


def levenshtein_ratio(a: str, b: str) -> float:
    a = _normalize_text(a)
    b = _normalize_text(b)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0

    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            insert = current[j - 1] + 1
            delete = previous[j] + 1
            replace = previous[j - 1] + (0 if ca == cb else 1)
            current.append(min(insert, delete, replace))
        previous = current

    distance = previous[-1]
    return max(0.0, 1.0 - distance / max(len(a), len(b)))


def cosine_text_similarity(a: str | None, b: str | None) -> float:
    left = _tokens(a)
    right = _tokens(b)
    if not left or not right:
        return 0.0

    intersection = set(left) & set(right)
    numerator = sum(left[token] * right[token] for token in intersection)
    left_norm = math.sqrt(sum(count * count for count in left.values()))
    right_norm = math.sqrt(sum(count * count for count in right.values()))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return numerator / (left_norm * right_norm)


def _years_since(date_value: str | None) -> float:
    if not date_value:
        return 0
    parsed = datetime.fromisoformat(date_value.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - parsed).days / 365.25


def build_github_explanations(profile: dict[str, Any], query: str) -> list[dict[str, Any]]:
    login = profile.get("login") or ""
    name = profile.get("name") or ""
    bio = profile.get("bio") or ""
    company = profile.get("company") or ""
    location = profile.get("location") or ""
    created_at = profile.get("created_at")

    username_score = levenshtein_ratio(login, query.strip().lstrip("@"))
    bio_score = cosine_text_similarity(" ".join([query, login]), " ".join([name, bio]))
    company_score = 1.0 if company else 0.0
    location_score = 1.0 if location else 0.0
    age_years = _years_since(created_at)
    age_score = min(age_years / 5.0, 1.0)

    items = [
        {
            "signal_type": "username_similarity",
            "raw_score": round(username_score, 3),
            "weight": 42,
            "points": round(username_score * 42, 2),
            "human_readable_reason": f"GitHub login '{login}' was compared with the searched handle '{query.strip()}'.",
        },
        {
            "signal_type": "bio_similarity",
            "raw_score": round(bio_score, 3),
            "weight": 22,
            "points": round(bio_score * 22, 2),
            "human_readable_reason": "Public profile name and bio were compared against the searched handle and login text.",
        },
        {
            "signal_type": "location_match",
            "raw_score": round(location_score, 3),
            "weight": 10,
            "points": round(location_score * 10, 2),
            "human_readable_reason": f"GitHub exposes a public location field: '{location}'." if location else "No public location field was available from GitHub.",
        },
        {
            "signal_type": "employer_match",
            "raw_score": round(company_score, 3),
            "weight": 10,
            "points": round(company_score * 10, 2),
            "human_readable_reason": f"GitHub exposes a public company/employer field: '{company}'." if company else "No public company/employer field was available from GitHub.",
        },
        {
            "signal_type": "timezone_match",
            "raw_score": round(age_score, 3),
            "weight": 16,
            "points": round(age_score * 16, 2),
            "human_readable_reason": f"The account was created {age_years:.1f} years ago; older accounts provide stronger continuity evidence.",
        },
    ]

    return sorted(items, key=lambda item: item["points"], reverse=True)


def confidence_from_explanations(explanations: list[dict[str, Any]]) -> float:
    total = sum(item["points"] for item in explanations)
    return round(max(0.0, min(100.0, total)), 2)

