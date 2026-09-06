from functools import lru_cache
from pydantic import BaseModel
import os


class Settings(BaseModel):
    app_name: str = "novi"
    database_path: str = os.getenv("NOVI_DATABASE_PATH", "novi.db")
    github_token: str | None = os.getenv("GITHUB_TOKEN")
    enable_github_collector: bool = os.getenv("NOVI_ENABLE_GITHUB_COLLECTOR", "true").lower() == "true"


@lru_cache
def get_settings() -> Settings:
    return Settings()

