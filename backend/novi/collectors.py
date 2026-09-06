from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from .config import get_settings


class CollectorDisabledError(RuntimeError):
    pass


def _headers() -> dict[str, str]:
    settings = get_settings()
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "novi-osint-self-audit-demo",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if settings.github_token:
        headers["Authorization"] = f"Bearer {settings.github_token}"
    return headers


async def collect_github_user(handle: str) -> dict[str, Any]:
    settings = get_settings()
    if not settings.enable_github_collector:
        raise CollectorDisabledError("GitHub collector is disabled by NOVI_ENABLE_GITHUB_COLLECTOR.")

    clean_handle = handle.strip().lstrip("@")
    if not clean_handle:
        raise ValueError("A GitHub handle is required.")

    async with httpx.AsyncClient(timeout=12) as client:
        response = await client.get(
            f"https://api.github.com/users/{clean_handle}",
            headers=_headers(),
        )
        if response.status_code == 404:
            raise ValueError(f"No public GitHub profile was found for '{clean_handle}'.")
        response.raise_for_status()
        profile = response.json()

    profile["collected_at"] = datetime.now(timezone.utc).isoformat()
    profile["source"] = "github_api"
    profile["source_url"] = profile.get("html_url") or f"https://github.com/{clean_handle}"
    return profile

