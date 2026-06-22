from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
from typing import Literal, Protocol

from app.core.settings import AppPaths, get_app_paths


MemoryNamespace = Literal["persona", "memory", "appearance"]
MemorySource = Literal["player", "assistant", "system"]

_TOKEN_PATTERN = re.compile(r"[a-z0-9']+")
_IMPORTANT_TOKENS = frozenset(
    {
        "allergic",
        "allergy",
        "always",
        "anniversary",
        "birthday",
        "born",
        "brother",
        "consent",
        "daughter",
        "dislike",
        "family",
        "favorite",
        "favourite",
        "hate",
        "hometown",
        "husband",
        "important",
        "love",
        "married",
        "name",
        "named",
        "never",
        "partner",
        "plan",
        "prefer",
        "preference",
        "promise",
        "remember",
        "sister",
        "son",
        "wife",
    }
)
_APPEARANCE_HINT_TOKENS = frozenset({"appearance", "dress", "hair", "look", "outfit", "style", "wearing"})
DEFAULT_MEMORY_POLICY = (
    "Store durable preferences, promises, relationship facts, emotional history, important dates, plans, "
    "summaries, and explicit consent flags. Avoid raw imagery, meshes, or transient appearance details."
)
DEFAULT_PRIVACY_POLICY = (
    "Appearance stays separate from persona and episodic memory. Only store semantic appearance notes when the "
    "user explicitly makes them meaningful."
)
# A memory at/above this salience is treated as a durable fact and stays
# recall-eligible even without token overlap with the current message; below it,
# a memory is only recalled when it is topically relevant (see _score_memory_entries).
_DURABLE_RECALL_SALIENCE = 0.6
# Size of the recent-conversation candidate window, and a generous safety cap on
# how many always-retained durable facts are pulled per turn (durable facts are
# few next to chatter; this only bounds prompt-scoring cost, not what's stored).
_RECENT_RECALL_WINDOW = 64
_DURABLE_RECALL_CAP = 256
# Function words excluded when measuring topical overlap, so a memory is not
# pulled into the prompt just because it shares "the"/"about"/"is" with the
# current message (that surfaced unrelated past topics for no reason).
_RECALL_STOPWORDS = frozenset(
    {
        "a", "about", "after", "all", "am", "an", "and", "any", "are", "as", "at", "be",
        "been", "but", "by", "can", "could", "did", "do", "does", "for", "from", "get",
        "had", "has", "have", "he", "her", "him", "his", "how", "i", "if", "in", "into",
        "is", "it", "its", "just", "know", "like", "me", "my", "no", "not", "now", "of",
        "off", "on", "one", "or", "our", "out", "over", "please", "she", "should", "so",
        "some", "tell", "that", "the", "their", "them", "then", "there", "they", "this",
        "to", "up", "us", "want", "was", "we", "were", "what", "when", "where", "which",
        "who", "why", "will", "with", "would", "you", "your",
    }
)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_text(text: str) -> str:
    return " ".join(_TOKEN_PATTERN.findall(text.lower()))


def _normalize_tags(tags: tuple[str, ...] | list[str] | None) -> tuple[str, ...]:
    if not tags:
        return ()

    normalized: list[str] = []
    for raw_tag in tags:
        tag = str(raw_tag).strip().lower()
        if tag and tag not in normalized:
            normalized.append(tag)
    return tuple(normalized)


def estimate_memory_salience(text: str, *, explicit_tags: tuple[str, ...] = ()) -> float:
    normalized = _normalize_text(text)
    if not normalized:
        return 0.0

    tokens = normalized.split()
    important_hits = sum(1 for token in tokens if token in _IMPORTANT_TOKENS)
    question_bonus = 0.15 if text.strip().endswith("?") else 0.0
    appearance_bonus = 0.1 if any(token in _APPEARANCE_HINT_TOKENS for token in tokens) else 0.0
    explicit_bonus = min(0.25, len(explicit_tags) * 0.05)
    length_bonus = min(0.2, len(tokens) / 60.0)
    score = 0.25 + important_hits * 0.15 + question_bonus + appearance_bonus + explicit_bonus + length_bonus
    # Anything naming a durable life fact (birthday, where you were born, family,
    # a stated preference/promise) is floored to durable salience so it qualifies
    # for permanent, always-retained recall regardless of how it was phrased.
    if important_hits:
        score = max(score, _DURABLE_RECALL_SALIENCE)
    return max(0.0, min(score, 1.0))


@dataclass(slots=True, frozen=True)
class PersonaCoreRecord:
    persona_id: str
    display_name: str
    speech_style: str | None = None
    core_traits: tuple[str, ...] = field(default_factory=tuple)
    moral_constraints: tuple[str, ...] = field(default_factory=tuple)
    long_term_goals: tuple[str, ...] = field(default_factory=tuple)
    memory_policy: str = DEFAULT_MEMORY_POLICY
    privacy_policy: str = DEFAULT_PRIVACY_POLICY
    active_appearance_id: str | None = None


@dataclass(slots=True, frozen=True)
class DemeanorRecord:
    persona_id: str
    mood: str = "calm"
    energy_level: float = 0.45
    conversation_mode: str = "supportive"


@dataclass(slots=True, frozen=True)
class AppearanceRecord:
    appearance_id: str
    persona_id: str
    summary: str
    thumbnail_ref: str | None = None
    tags: tuple[str, ...] = field(default_factory=tuple)
    vrm_metadata: dict[str, object] = field(default_factory=dict)
    created_at: str = field(default_factory=_utc_now_iso)


@dataclass(slots=True, frozen=True)
class MemoryEntryRecord:
    entry_id: int
    persona_id: str
    namespace: MemoryNamespace
    source: MemorySource
    role: str
    summary: str
    content: str
    salience: float
    tags: tuple[str, ...] = field(default_factory=tuple)
    appearance_id: str | None = None
    session_id: str | None = None
    locale: str | None = None
    created_at: str = field(default_factory=_utc_now_iso)


@dataclass(slots=True, frozen=True)
class CompanionMemoryContext:
    persona: PersonaCoreRecord
    demeanor: DemeanorRecord
    active_appearance: AppearanceRecord | None = None
    retrieved_memories: tuple[MemoryEntryRecord, ...] = field(default_factory=tuple)
    recent_memories: tuple[MemoryEntryRecord, ...] = field(default_factory=tuple)


class CompanionMemoryService(Protocol):
    def ensure_persona_core(
        self,
        *,
        persona_id: str,
        display_name: str,
        speech_style: str | None = None,
        core_traits: tuple[str, ...] = (),
        moral_constraints: tuple[str, ...] = (),
        long_term_goals: tuple[str, ...] = (),
    ) -> PersonaCoreRecord:
        raise NotImplementedError

    def get_prompt_context(
        self,
        *,
        persona_id: str,
        query_text: str,
        include_appearance_context: bool = False,
        limit: int = 4,
    ) -> CompanionMemoryContext:
        raise NotImplementedError

    def append_memory(
        self,
        *,
        persona_id: str,
        namespace: MemoryNamespace,
        source: MemorySource,
        role: str,
        summary: str,
        content: str,
        salience: float,
        tags: tuple[str, ...] = (),
        appearance_id: str | None = None,
        session_id: str | None = None,
        locale: str | None = None,
    ) -> MemoryEntryRecord:
        raise NotImplementedError

    def store_turn(
        self,
        *,
        persona_id: str,
        session_id: str,
        locale: str,
        user_text: str,
        assistant_text: str,
        assistant_status: str,
        memory_writebacks: tuple[dict[str, object], ...] = (),
        feeling_name: str | None = None,
        voice_energy: float | None = None,
    ) -> None:
        raise NotImplementedError

    def update_demeanor(
        self,
        *,
        persona_id: str,
        mood: str | None = None,
        energy_level: float | None = None,
        conversation_mode: str | None = None,
    ) -> DemeanorRecord:
        raise NotImplementedError


@dataclass(slots=True)
class SqliteCompanionMemoryService:
    database_path: Path

    def __post_init__(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize_schema()

    def ensure_persona_core(
        self,
        *,
        persona_id: str,
        display_name: str,
        speech_style: str | None = None,
        core_traits: tuple[str, ...] = (),
        moral_constraints: tuple[str, ...] = (),
        long_term_goals: tuple[str, ...] = (),
    ) -> PersonaCoreRecord:
        with self._open_connection() as connection:
            connection.execute(
                """
                INSERT INTO persona_core (
                    persona_id,
                    display_name,
                    speech_style,
                    core_traits_json,
                    moral_constraints_json,
                    long_term_goals_json,
                    memory_policy,
                    privacy_policy,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(persona_id) DO UPDATE SET
                    display_name = excluded.display_name,
                    speech_style = COALESCE(excluded.speech_style, persona_core.speech_style),
                    core_traits_json = CASE WHEN excluded.core_traits_json != '[]' THEN excluded.core_traits_json ELSE persona_core.core_traits_json END,
                    moral_constraints_json = CASE WHEN excluded.moral_constraints_json != '[]' THEN excluded.moral_constraints_json ELSE persona_core.moral_constraints_json END,
                    long_term_goals_json = CASE WHEN excluded.long_term_goals_json != '[]' THEN excluded.long_term_goals_json ELSE persona_core.long_term_goals_json END,
                    updated_at = excluded.updated_at
                """,
                (
                    persona_id,
                    display_name,
                    speech_style,
                    json.dumps(list(core_traits)),
                    json.dumps(list(moral_constraints)),
                    json.dumps(list(long_term_goals)),
                    DEFAULT_MEMORY_POLICY,
                    DEFAULT_PRIVACY_POLICY,
                    _utc_now_iso(),
                ),
            )
            row = connection.execute(
                "SELECT * FROM persona_core WHERE persona_id = ?",
                (persona_id,),
            ).fetchone()
            demeanor_row = connection.execute(
                "SELECT * FROM demeanor_state WHERE persona_id = ?",
                (persona_id,),
            ).fetchone()
            if demeanor_row is None:
                connection.execute(
                    "INSERT INTO demeanor_state (persona_id, updated_at) VALUES (?, ?)",
                    (persona_id, _utc_now_iso()),
                )

        assert row is not None
        return self._persona_from_row(row)

    def get_prompt_context(
        self,
        *,
        persona_id: str,
        query_text: str,
        include_appearance_context: bool = False,
        limit: int = 4,
    ) -> CompanionMemoryContext:
        with self._open_connection() as connection:
            persona_row = connection.execute(
                "SELECT * FROM persona_core WHERE persona_id = ?",
                (persona_id,),
            ).fetchone()
            demeanor_row = connection.execute(
                "SELECT * FROM demeanor_state WHERE persona_id = ?",
                (persona_id,),
            ).fetchone()
            # Candidate set = the recent conversation window (for relevance/recency)
            # UNION all durable facts regardless of age, so important facts
            # (birthday, where you were born, preferences, promises) are NEVER
            # aged out of recall even after thousands of later turns. Durable =
            # high-salience and NOT a raw conversation turn (raw turns are tagged
            # "dialog"; they only ever surface via topical overlap).
            memory_rows = connection.execute(
                """
                SELECT *
                FROM memory_entries
                WHERE persona_id = ?
                  AND namespace = 'memory'
                  AND (
                    entry_id IN (
                      SELECT entry_id FROM memory_entries
                      WHERE persona_id = ? AND namespace = 'memory'
                      ORDER BY entry_id DESC LIMIT ?
                    )
                    OR entry_id IN (
                      SELECT entry_id FROM memory_entries
                      WHERE persona_id = ? AND namespace = 'memory'
                        AND salience >= ?
                        AND tags_json NOT LIKE '%"dialog"%'
                      ORDER BY entry_id DESC LIMIT ?
                    )
                  )
                ORDER BY entry_id DESC
                """,
                (
                    persona_id,
                    persona_id,
                    _RECENT_RECALL_WINDOW,
                    persona_id,
                    _DURABLE_RECALL_SALIENCE,
                    _DURABLE_RECALL_CAP,
                ),
            ).fetchall()

            appearance_row = None
            if include_appearance_context and persona_row is not None:
                active_appearance_id = persona_row["active_appearance_id"]
                if active_appearance_id:
                    appearance_row = connection.execute(
                        "SELECT * FROM appearance_versions WHERE appearance_id = ?",
                        (active_appearance_id,),
                    ).fetchone()

        persona = self._persona_from_row(persona_row) if persona_row is not None else PersonaCoreRecord(
            persona_id=persona_id,
            display_name=persona_id,
        )
        demeanor = self._demeanor_from_row(demeanor_row) if demeanor_row is not None else DemeanorRecord(persona_id=persona_id)
        entries = [self._memory_from_row(row) for row in memory_rows]
        scored_entries = self._score_memory_entries(entries, query_text=query_text)
        retrieved = tuple(entry for _, entry in scored_entries[: max(limit, 0)])
        recent = tuple(entries[: min(4, len(entries))])
        active_appearance = self._appearance_from_row(appearance_row) if appearance_row is not None else None
        return CompanionMemoryContext(
            persona=persona,
            demeanor=demeanor,
            active_appearance=active_appearance,
            retrieved_memories=retrieved,
            recent_memories=recent,
        )

    def append_memory(
        self,
        *,
        persona_id: str,
        namespace: MemoryNamespace,
        source: MemorySource,
        role: str,
        summary: str,
        content: str,
        salience: float,
        tags: tuple[str, ...] = (),
        appearance_id: str | None = None,
        session_id: str | None = None,
        locale: str | None = None,
    ) -> MemoryEntryRecord:
        normalized_summary = summary.strip()
        normalized_content = content.strip()
        normalized_tags = _normalize_tags(tags)
        timestamp = _utc_now_iso()
        bounded_salience = max(0.0, min(float(salience), 1.0))
        with self._open_connection() as connection:
            cursor = connection.execute(
                """
                INSERT INTO memory_entries (
                    persona_id,
                    namespace,
                    source,
                    role,
                    summary,
                    content,
                    salience,
                    tags_json,
                    appearance_id,
                    session_id,
                    locale,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    persona_id,
                    namespace,
                    source,
                    role,
                    normalized_summary,
                    normalized_content,
                    bounded_salience,
                    json.dumps(list(normalized_tags)),
                    appearance_id,
                    session_id,
                    locale,
                    timestamp,
                ),
            )
            entry_id = int(cursor.lastrowid)

        return MemoryEntryRecord(
            entry_id=entry_id,
            persona_id=persona_id,
            namespace=namespace,
            source=source,
            role=role,
            summary=normalized_summary,
            content=normalized_content,
            salience=bounded_salience,
            tags=normalized_tags,
            appearance_id=appearance_id,
            session_id=session_id,
            locale=locale,
            created_at=timestamp,
        )

    def store_turn(
        self,
        *,
        persona_id: str,
        session_id: str,
        locale: str,
        user_text: str,
        assistant_text: str,
        assistant_status: str,
        memory_writebacks: tuple[dict[str, object], ...] = (),
        feeling_name: str | None = None,
        voice_energy: float | None = None,
    ) -> None:
        normalized_user_text = user_text.strip()
        if normalized_user_text:
            self.append_memory(
                persona_id=persona_id,
                namespace="memory",
                source="player",
                role="user_turn",
                summary=normalized_user_text[:160],
                content=normalized_user_text,
                salience=estimate_memory_salience(normalized_user_text, explicit_tags=("dialog",)),
                tags=("dialog", "player"),
                session_id=session_id,
                locale=locale,
            )

        normalized_assistant_text = assistant_text.strip()
        if normalized_assistant_text and assistant_status in {"ready", "degraded"}:
            assistant_tags = ["dialog", "assistant"]
            if feeling_name:
                assistant_tags.append(feeling_name)
            self.append_memory(
                persona_id=persona_id,
                namespace="memory",
                source="assistant",
                role="assistant_turn",
                summary=normalized_assistant_text[:160],
                content=normalized_assistant_text,
                salience=estimate_memory_salience(normalized_assistant_text, explicit_tags=tuple(assistant_tags)),
                tags=tuple(assistant_tags),
                session_id=session_id,
                locale=locale,
            )

        for writeback in memory_writebacks:
            namespace = str(writeback.get("namespace") or "memory").strip().lower()
            if namespace not in {"persona", "memory", "appearance"}:
                namespace = "memory"
            summary = str(writeback.get("summary") or "").strip()
            if not summary:
                continue
            salience = writeback.get("salience")
            normalized_salience = (
                max(0.0, min(float(salience), 1.0))
                if isinstance(salience, (int, float))
                else estimate_memory_salience(summary)
            )
            # Never let an important life fact be under-rated below durable recall,
            # even if the planner assigned it a low salience.
            if any(token in _IMPORTANT_TOKENS for token in _normalize_text(summary).split()):
                normalized_salience = max(normalized_salience, _DURABLE_RECALL_SALIENCE)
            tags = writeback.get("tags")
            source = str(writeback.get("source") or "assistant").strip().lower()
            if source not in {"assistant", "player", "system"}:
                source = "assistant"
            self.append_memory(
                persona_id=persona_id,
                namespace=namespace,
                source=source,
                role="writeback",
                summary=summary,
                content=summary,
                salience=normalized_salience,
                tags=tuple(str(tag) for tag in tags) if isinstance(tags, (list, tuple)) else (),
                session_id=session_id,
                locale=locale,
            )

        if feeling_name is not None or voice_energy is not None:
            self.update_demeanor(
                persona_id=persona_id,
                mood=feeling_name,
                energy_level=voice_energy,
            )

    def update_demeanor(
        self,
        *,
        persona_id: str,
        mood: str | None = None,
        energy_level: float | None = None,
        conversation_mode: str | None = None,
    ) -> DemeanorRecord:
        with self._open_connection() as connection:
            existing = connection.execute(
                "SELECT * FROM demeanor_state WHERE persona_id = ?",
                (persona_id,),
            ).fetchone()
            current = self._demeanor_from_row(existing) if existing is not None else DemeanorRecord(persona_id=persona_id)
            updated = DemeanorRecord(
                persona_id=persona_id,
                mood=(mood.strip() if isinstance(mood, str) and mood.strip() else current.mood),
                energy_level=(max(0.0, min(float(energy_level), 1.0)) if energy_level is not None else current.energy_level),
                conversation_mode=(
                    conversation_mode.strip()
                    if isinstance(conversation_mode, str) and conversation_mode.strip()
                    else current.conversation_mode
                ),
            )
            connection.execute(
                """
                INSERT INTO demeanor_state (persona_id, mood, energy_level, conversation_mode, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(persona_id) DO UPDATE SET
                    mood = excluded.mood,
                    energy_level = excluded.energy_level,
                    conversation_mode = excluded.conversation_mode,
                    updated_at = excluded.updated_at
                """,
                (
                    updated.persona_id,
                    updated.mood,
                    updated.energy_level,
                    updated.conversation_mode,
                    _utc_now_iso(),
                ),
            )

        return updated

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    @contextmanager
    def _open_connection(self):
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _initialize_schema(self) -> None:
        with self._open_connection() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS persona_core (
                    persona_id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    speech_style TEXT,
                    core_traits_json TEXT NOT NULL DEFAULT '[]',
                    moral_constraints_json TEXT NOT NULL DEFAULT '[]',
                    long_term_goals_json TEXT NOT NULL DEFAULT '[]',
                    memory_policy TEXT NOT NULL,
                    privacy_policy TEXT NOT NULL,
                    active_appearance_id TEXT,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS demeanor_state (
                    persona_id TEXT PRIMARY KEY,
                    mood TEXT NOT NULL DEFAULT 'calm',
                    energy_level REAL NOT NULL DEFAULT 0.45,
                    conversation_mode TEXT NOT NULL DEFAULT 'supportive',
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS appearance_versions (
                    appearance_id TEXT PRIMARY KEY,
                    persona_id TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    thumbnail_ref TEXT,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    vrm_metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    is_active INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS memory_entries (
                    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    persona_id TEXT NOT NULL,
                    namespace TEXT NOT NULL,
                    source TEXT NOT NULL,
                    role TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    content TEXT NOT NULL,
                    salience REAL NOT NULL,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    appearance_id TEXT,
                    session_id TEXT,
                    locale TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
                ON memory_entries (persona_id, namespace, entry_id DESC)
                """
            )

    @staticmethod
    def _decode_json_array(raw_value: object) -> tuple[str, ...]:
        if raw_value is None:
            return ()
        try:
            decoded = json.loads(str(raw_value))
        except json.JSONDecodeError:
            return ()
        if not isinstance(decoded, list):
            return ()
        return tuple(str(item) for item in decoded if str(item).strip())

    @staticmethod
    def _decode_json_object(raw_value: object) -> dict[str, object]:
        if raw_value is None:
            return {}
        try:
            decoded = json.loads(str(raw_value))
        except json.JSONDecodeError:
            return {}
        return decoded if isinstance(decoded, dict) else {}

    def _persona_from_row(self, row: sqlite3.Row) -> PersonaCoreRecord:
        return PersonaCoreRecord(
            persona_id=str(row["persona_id"]),
            display_name=str(row["display_name"]),
            speech_style=str(row["speech_style"]) if row["speech_style"] is not None else None,
            core_traits=self._decode_json_array(row["core_traits_json"]),
            moral_constraints=self._decode_json_array(row["moral_constraints_json"]),
            long_term_goals=self._decode_json_array(row["long_term_goals_json"]),
            memory_policy=str(row["memory_policy"]),
            privacy_policy=str(row["privacy_policy"]),
            active_appearance_id=str(row["active_appearance_id"]) if row["active_appearance_id"] is not None else None,
        )

    def _demeanor_from_row(self, row: sqlite3.Row) -> DemeanorRecord:
        return DemeanorRecord(
            persona_id=str(row["persona_id"]),
            mood=str(row["mood"]),
            energy_level=float(row["energy_level"]),
            conversation_mode=str(row["conversation_mode"]),
        )

    def _appearance_from_row(self, row: sqlite3.Row) -> AppearanceRecord:
        return AppearanceRecord(
            appearance_id=str(row["appearance_id"]),
            persona_id=str(row["persona_id"]),
            summary=str(row["summary"]),
            thumbnail_ref=str(row["thumbnail_ref"]) if row["thumbnail_ref"] is not None else None,
            tags=self._decode_json_array(row["tags_json"]),
            vrm_metadata=self._decode_json_object(row["vrm_metadata_json"]),
            created_at=str(row["created_at"]),
        )

    def _memory_from_row(self, row: sqlite3.Row) -> MemoryEntryRecord:
        return MemoryEntryRecord(
            entry_id=int(row["entry_id"]),
            persona_id=str(row["persona_id"]),
            namespace=str(row["namespace"]),
            source=str(row["source"]),
            role=str(row["role"]),
            summary=str(row["summary"]),
            content=str(row["content"]),
            salience=float(row["salience"]),
            tags=self._decode_json_array(row["tags_json"]),
            appearance_id=str(row["appearance_id"]) if row["appearance_id"] is not None else None,
            session_id=str(row["session_id"]) if row["session_id"] is not None else None,
            locale=str(row["locale"]) if row["locale"] is not None else None,
            created_at=str(row["created_at"]),
        )

    @staticmethod
    def _score_memory_entries(entries: list[MemoryEntryRecord], *, query_text: str) -> list[tuple[float, MemoryEntryRecord]]:
        # Relevance-gated recall, by entry kind:
        #  - Raw conversation turns (tagged "dialog") are recalled ONLY when they
        #    are topically relevant to the current message (token overlap). They
        #    never surface on salience/recency alone.
        #  - Durable writebacks (preferences/promises/plans) may also surface on
        #    high salience even without overlap, so they persist across topics.
        #
        # Recency must NOT force a memory back into the prompt: previously we
        # force-included the last few entries (offset < 3) plus a recency bonus,
        # which made her resurface the immediately preceding topic for no reason
        # (ask about the UK, then about SpaceX, and she'd loop back to the UK).
        # Recency now only breaks ties between otherwise-eligible memories.
        query_tokens = set(_normalize_text(query_text).split()) - _RECALL_STOPWORDS
        scored: list[tuple[float, MemoryEntryRecord]] = []
        for offset, entry in enumerate(entries):
            memory_tokens = set(_normalize_text(f"{entry.summary} {entry.content}").split()) - _RECALL_STOPWORDS
            overlap = len(query_tokens & memory_tokens)
            is_dialog_turn = "dialog" in entry.tags
            salience_eligible = (not is_dialog_turn) and entry.salience >= _DURABLE_RECALL_SALIENCE
            if overlap == 0 and not salience_eligible:
                continue
            recency_tiebreak = max(0.0, 0.05 - offset * 0.005)
            score = entry.salience + overlap * 0.2 + recency_tiebreak
            scored.append((score, entry))

        scored.sort(key=lambda item: item[0], reverse=True)
        return scored


def build_companion_memory_service(app_paths: AppPaths | None = None) -> CompanionMemoryService:
    resolved_paths = app_paths or get_app_paths()
    return SqliteCompanionMemoryService(
        database_path=resolved_paths.local_data_root / "memory" / "companion-memory.sqlite3"
    )