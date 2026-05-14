from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import sqlite3
from typing import Protocol

from app.core.settings import AppPaths, get_app_paths


_TOKEN_PATTERN = re.compile(r"[a-z0-9]+")
_RETRIEVABLE_STATUSES = frozenset({"degraded", "final", "ready"})


def _normalize_text(text: str) -> str:
    return " ".join(_TOKEN_PATTERN.findall(text.lower()))


@dataclass(slots=True, frozen=True)
class MemoryExchange:
    exchange_id: int
    session_id: str
    character_id: str
    user_text: str
    assistant_text: str
    assistant_status: str
    locale: str


class SessionMemoryService(Protocol):
    def store_exchange(
        self,
        *,
        session_id: str,
        character_id: str,
        user_text: str,
        assistant_text: str,
        assistant_status: str,
        locale: str,
    ) -> None:
        raise NotImplementedError

    def retrieve_relevant_exchanges(
        self,
        *,
        session_id: str,
        character_id: str,
        query_text: str,
        limit: int = 3,
    ) -> tuple[MemoryExchange, ...]:
        raise NotImplementedError


@dataclass(slots=True)
class SqliteSessionMemoryService:
    database_path: Path

    def __post_init__(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize_schema()

    def store_exchange(
        self,
        *,
        session_id: str,
        character_id: str,
        user_text: str,
        assistant_text: str,
        assistant_status: str,
        locale: str,
    ) -> None:
        normalized_user_text = user_text.strip()
        normalized_assistant_text = assistant_text.strip()

        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO session_memory (
                    session_id,
                    character_id,
                    user_text,
                    assistant_text,
                    assistant_status,
                    locale
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    character_id,
                    normalized_user_text,
                    normalized_assistant_text,
                    assistant_status,
                    locale,
                ),
            )

    def retrieve_relevant_exchanges(
        self,
        *,
        session_id: str,
        character_id: str,
        query_text: str,
        limit: int = 3,
    ) -> tuple[MemoryExchange, ...]:
        normalized_query = _normalize_text(query_text)
        if not normalized_query or limit <= 0:
            return ()

        query_tokens = set(normalized_query.split())
        candidates: list[tuple[int, int, int, MemoryExchange]] = []

        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    exchange_id,
                    session_id,
                    character_id,
                    user_text,
                    assistant_text,
                    assistant_status,
                    locale
                FROM session_memory
                WHERE session_id = ?
                  AND character_id = ?
                ORDER BY exchange_id DESC
                """,
                (session_id, character_id),
            ).fetchall()

        for row in rows:
            exchange = MemoryExchange(
                exchange_id=int(row["exchange_id"]),
                session_id=str(row["session_id"]),
                character_id=str(row["character_id"]),
                user_text=str(row["user_text"]),
                assistant_text=str(row["assistant_text"]),
                assistant_status=str(row["assistant_status"]),
                locale=str(row["locale"]),
            )

            if exchange.assistant_status not in _RETRIEVABLE_STATUSES:
                continue

            normalized_exchange = _normalize_text(
                f"{exchange.user_text} {exchange.assistant_text}"
            )
            if not normalized_exchange:
                continue

            exchange_tokens = set(normalized_exchange.split())
            overlap_score = len(query_tokens & exchange_tokens)
            phrase_score = int(normalized_query in normalized_exchange)
            if phrase_score == 0 and overlap_score == 0:
                continue

            candidates.append((phrase_score, overlap_score, exchange.exchange_id, exchange))

        candidates.sort(key=lambda item: (-item[0], -item[1], -item[2]))
        return tuple(item[3] for item in candidates[:limit])

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize_schema(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS session_memory (
                    exchange_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    character_id TEXT NOT NULL,
                    user_text TEXT NOT NULL,
                    assistant_text TEXT NOT NULL,
                    assistant_status TEXT NOT NULL,
                    locale TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_session_memory_scope
                ON session_memory (session_id, character_id, exchange_id DESC)
                """
            )


def build_session_memory_service(
    app_paths: AppPaths | None = None,
) -> SessionMemoryService:
    resolved_paths = app_paths or get_app_paths()
    return SqliteSessionMemoryService(
        database_path=resolved_paths.local_data_root / "memory" / "session-memory.sqlite3"
    )