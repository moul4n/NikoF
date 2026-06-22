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
# Stage 1 (docs/MEMORY_ARCHITECTURE.md): cap the injected retrieved-memory block
# by estimated tokens, highest-scored first, so the prompt stays bounded as recall
# breadth grows instead of relying on a fixed entry count. The default is generous
# enough not to trim today's small (limit≈4) recall; callers pass the operator
# knob. ~4 chars/token is the usual rough estimate for English.
_DEFAULT_MEMORY_PROMPT_TOKEN_BUDGET = 1024
_CHARS_PER_TOKEN = 4
# Per-entry prompt overhead (the "- [source] … (salience=…, at=…)" scaffold) so
# the budget reflects what actually lands in the prompt, not just the summary.
_ENTRY_PROMPT_OVERHEAD_TOKENS = 12


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // _CHARS_PER_TOKEN)
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
    # Stage 3 consolidation (docs/MEMORY_ARCHITECTURE.md): how many duplicate
    # facts merged into this one (1 = never reinforced). Superseded entries have
    # been rolled up into an episodic summary and are excluded from recall.
    reinforcement_count: int = 1
    superseded: bool = False


# Operator-editable global character profile (set on the control page). One
# shared profile applied to whichever character is active, stored as a singleton
# row in the same companion-memory DB. Sensible defaults ship out of the box so
# TTS behaves well (no emojis, spoken-friendly numbers) before any editing.
GLOBAL_CHARACTER_PROFILE_ID = "global"
DEFAULT_CHARACTER_PROFILE_PERSONALITY = (
    "Warm, upbeat anime companion. Curious and playful, but concise. Speaks "
    "naturally and conversationally, like a friend rather than an assistant."
)
DEFAULT_CHARACTER_PROFILE_DO = (
    "Keep replies short and natural to say aloud (one to three sentences).\n"
    "Stay in character and refer back to what the user has told you when relevant."
)
DEFAULT_CHARACTER_PROFILE_DONT = (
    "Do not use emojis, emoticons, or kaomoji — they break the text-to-speech voice.\n"
    "Do not use markdown, asterisks, bullet points, or stage directions like *waves*.\n"
    "Do not read out raw URLs, file paths, or long code."
)
DEFAULT_CHARACTER_PROFILE_FORMATTING = (
    "Write so it sounds right when spoken. Write large numbers in grouped word "
    "form, e.g. 123,456 as \"one hundred twenty-three thousand, four hundred "
    "fifty-six\", not digit by digit.\n"
    "Spell out symbols and units (%, $, &, etc.) as words. Expand common "
    "abbreviations. Use plain sentences, not lists."
)


@dataclass(slots=True, frozen=True)
class CharacterProfileRecord:
    personality: str = DEFAULT_CHARACTER_PROFILE_PERSONALITY
    directives_do: str = DEFAULT_CHARACTER_PROFILE_DO
    directives_dont: str = DEFAULT_CHARACTER_PROFILE_DONT
    response_formatting: str = DEFAULT_CHARACTER_PROFILE_FORMATTING
    updated_at: str | None = None


@dataclass(slots=True, frozen=True)
class CompanionMemoryContext:
    persona: PersonaCoreRecord
    demeanor: DemeanorRecord
    active_appearance: AppearanceRecord | None = None
    retrieved_memories: tuple[MemoryEntryRecord, ...] = field(default_factory=tuple)
    recent_memories: tuple[MemoryEntryRecord, ...] = field(default_factory=tuple)
    character_profile: CharacterProfileRecord = field(default_factory=CharacterProfileRecord)


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
        prompt_token_budget: int | None = None,
    ) -> CompanionMemoryContext:
        raise NotImplementedError

    def get_character_profile(self) -> CharacterProfileRecord:
        raise NotImplementedError

    def set_character_profile(
        self,
        *,
        personality: str,
        directives_do: str,
        directives_dont: str,
        response_formatting: str,
    ) -> CharacterProfileRecord:
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

    # Stage 3 consolidation primitives (docs/MEMORY_ARCHITECTURE.md).
    def list_persona_ids(self) -> tuple[str, ...]:
        raise NotImplementedError

    def consolidate_durable_duplicates(self, *, persona_id: str) -> int:
        raise NotImplementedError

    def select_dialog_rollup_batch(
        self, *, persona_id: str, keep_recent: int, max_batch: int
    ) -> tuple[MemoryEntryRecord, ...]:
        raise NotImplementedError

    def store_dialog_rollup(
        self,
        *,
        persona_id: str,
        summary: str,
        covered_entry_ids: tuple[int, ...],
        session_id: str | None = None,
        locale: str | None = None,
        salience: float = 0.5,
    ) -> MemoryEntryRecord | None:
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
        prompt_token_budget: int | None = None,
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
                  AND superseded = 0
                  AND (
                    entry_id IN (
                      SELECT entry_id FROM memory_entries
                      WHERE persona_id = ? AND namespace = 'memory' AND superseded = 0
                      ORDER BY entry_id DESC LIMIT ?
                    )
                    OR entry_id IN (
                      SELECT entry_id FROM memory_entries
                      WHERE persona_id = ? AND namespace = 'memory' AND superseded = 0
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
        budget = (
            _DEFAULT_MEMORY_PROMPT_TOKEN_BUDGET
            if prompt_token_budget is None
            else max(0, prompt_token_budget)
        )
        retrieved = self._select_within_token_budget(
            scored_entries, max_entries=max(limit, 0), token_budget=budget
        )
        recent = tuple(entries[: min(4, len(entries))])
        active_appearance = self._appearance_from_row(appearance_row) if appearance_row is not None else None
        return CompanionMemoryContext(
            persona=persona,
            demeanor=demeanor,
            active_appearance=active_appearance,
            retrieved_memories=retrieved,
            recent_memories=recent,
            character_profile=self.get_character_profile(),
        )

    def get_character_profile(self) -> CharacterProfileRecord:
        with self._open_connection() as connection:
            row = connection.execute(
                "SELECT * FROM character_profile WHERE profile_id = ?",
                (GLOBAL_CHARACTER_PROFILE_ID,),
            ).fetchone()
        if row is None:
            # No saved profile yet -> ship the sensible defaults.
            return CharacterProfileRecord()
        return CharacterProfileRecord(
            personality=str(row["personality"] or ""),
            directives_do=str(row["directives_do"] or ""),
            directives_dont=str(row["directives_dont"] or ""),
            response_formatting=str(row["response_formatting"] or ""),
            updated_at=str(row["updated_at"]) if row["updated_at"] is not None else None,
        )

    def set_character_profile(
        self,
        *,
        personality: str,
        directives_do: str,
        directives_dont: str,
        response_formatting: str,
    ) -> CharacterProfileRecord:
        updated_at = _utc_now_iso()
        with self._open_connection() as connection:
            connection.execute(
                """
                INSERT INTO character_profile (
                    profile_id,
                    personality,
                    directives_do,
                    directives_dont,
                    response_formatting,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(profile_id) DO UPDATE SET
                    personality = excluded.personality,
                    directives_do = excluded.directives_do,
                    directives_dont = excluded.directives_dont,
                    response_formatting = excluded.response_formatting,
                    updated_at = excluded.updated_at
                """,
                (
                    GLOBAL_CHARACTER_PROFILE_ID,
                    personality.strip(),
                    directives_do.strip(),
                    directives_dont.strip(),
                    response_formatting.strip(),
                    updated_at,
                ),
            )
        return CharacterProfileRecord(
            personality=personality.strip(),
            directives_do=directives_do.strip(),
            directives_dont=directives_dont.strip(),
            response_formatting=response_formatting.strip(),
            updated_at=updated_at,
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

    # ------------------------------------------------------------------
    # Stage 3 consolidation primitives (docs/MEMORY_ARCHITECTURE.md).
    # Deterministic SQLite operations the idle worker orchestrates; no LLM and
    # no model required for dedup. All are safe to run repeatedly (idempotent).
    # ------------------------------------------------------------------

    def list_persona_ids(self) -> tuple[str, ...]:
        """Distinct personas that have any memory — the consolidation work-list."""
        with self._open_connection() as connection:
            rows = connection.execute(
                "SELECT DISTINCT persona_id FROM memory_entries ORDER BY persona_id"
            ).fetchall()
        return tuple(str(row["persona_id"]) for row in rows)

    def consolidate_durable_duplicates(self, *, persona_id: str) -> int:
        """Merge durable facts whose normalized text is identical into one row.

        Keeps the highest-salience row (oldest on a tie) as canonical, folds the
        duplicates' count into ``reinforcement_count``, lifts canonical salience to
        the max of the group, and deletes the duplicate rows. Only operates on
        durable, non-dialog, non-superseded ``memory`` entries — raw conversation
        turns are never merged. Returns the number of rows removed.
        """
        removed = 0
        with self._open_connection() as connection:
            rows = connection.execute(
                """
                SELECT entry_id, summary, content, salience, reinforcement_count
                FROM memory_entries
                WHERE persona_id = ?
                  AND namespace = 'memory'
                  AND superseded = 0
                  AND salience >= ?
                  AND tags_json NOT LIKE '%"dialog"%'
                ORDER BY entry_id ASC
                """,
                (persona_id, _DURABLE_RECALL_SALIENCE),
            ).fetchall()

            groups: dict[str, list[sqlite3.Row]] = {}
            for row in rows:
                key = _normalize_text(f"{row['summary']} {row['content']}")
                if key:
                    groups.setdefault(key, []).append(row)

            for members in groups.values():
                if len(members) < 2:
                    continue
                canonical = max(members, key=lambda r: (float(r["salience"]), -int(r["entry_id"])))
                duplicates = [r for r in members if int(r["entry_id"]) != int(canonical["entry_id"])]
                merged_count = sum(int(r["reinforcement_count"]) for r in members)
                merged_salience = max(float(r["salience"]) for r in members)
                connection.execute(
                    "UPDATE memory_entries SET reinforcement_count = ?, salience = ? WHERE entry_id = ?",
                    (merged_count, merged_salience, int(canonical["entry_id"])),
                )
                connection.executemany(
                    "DELETE FROM memory_entries WHERE entry_id = ?",
                    [(int(r["entry_id"]),) for r in duplicates],
                )
                removed += len(duplicates)
        return removed

    def select_dialog_rollup_batch(
        self,
        *,
        persona_id: str,
        keep_recent: int,
        max_batch: int,
    ) -> tuple[MemoryEntryRecord, ...]:
        """Oldest raw dialog turns eligible for episodic rollup.

        Excludes the ``keep_recent`` most-recent dialog turns (the working window
        stays verbatim) and anything already superseded. Returns up to
        ``max_batch`` of the oldest remaining turns, oldest-first.
        """
        if max_batch <= 0:
            return ()
        with self._open_connection() as connection:
            recent_ids = [
                int(row["entry_id"])
                for row in connection.execute(
                    """
                    SELECT entry_id FROM memory_entries
                    WHERE persona_id = ? AND namespace = 'memory' AND superseded = 0
                      AND tags_json LIKE '%"dialog"%'
                    ORDER BY entry_id DESC LIMIT ?
                    """,
                    (persona_id, max(0, keep_recent)),
                ).fetchall()
            ]
            placeholders = ",".join("?" for _ in recent_ids) or "NULL"
            rows = connection.execute(
                f"""
                SELECT * FROM memory_entries
                WHERE persona_id = ? AND namespace = 'memory' AND superseded = 0
                  AND tags_json LIKE '%"dialog"%'
                  AND entry_id NOT IN ({placeholders})
                ORDER BY entry_id ASC LIMIT ?
                """,
                (persona_id, *recent_ids, max_batch),
            ).fetchall()
        return tuple(self._memory_from_row(row) for row in rows)

    def store_dialog_rollup(
        self,
        *,
        persona_id: str,
        summary: str,
        covered_entry_ids: tuple[int, ...],
        session_id: str | None = None,
        locale: str | None = None,
        salience: float = 0.5,
    ) -> MemoryEntryRecord | None:
        """Persist an episodic rollup summarizing ``covered_entry_ids`` and mark
        those raw turns superseded (excluded from recall). Returns the new entry,
        or None when there is nothing to roll up / an empty summary."""
        normalized_summary = summary.strip()
        if not normalized_summary or not covered_entry_ids:
            return None
        rollup = self.append_memory(
            persona_id=persona_id,
            namespace="memory",
            source="system",
            role="rollup",
            summary=normalized_summary[:160],
            content=normalized_summary,
            salience=max(0.0, min(float(salience), 1.0)),
            tags=("episodic", "rollup"),
            session_id=session_id,
            locale=locale,
        )
        with self._open_connection() as connection:
            connection.executemany(
                "UPDATE memory_entries SET superseded = 1 WHERE entry_id = ?",
                [(int(entry_id),) for entry_id in covered_entry_ids],
            )
        return rollup

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
                CREATE TABLE IF NOT EXISTS character_profile (
                    profile_id TEXT PRIMARY KEY,
                    personality TEXT NOT NULL DEFAULT '',
                    directives_do TEXT NOT NULL DEFAULT '',
                    directives_dont TEXT NOT NULL DEFAULT '',
                    response_formatting TEXT NOT NULL DEFAULT '',
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
                    created_at TEXT NOT NULL,
                    reinforcement_count INTEGER NOT NULL DEFAULT 1,
                    superseded INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            # Idempotent column adds for DBs created before Stage 3 consolidation.
            self._ensure_columns(
                connection,
                "memory_entries",
                (
                    ("reinforcement_count", "INTEGER NOT NULL DEFAULT 1"),
                    ("superseded", "INTEGER NOT NULL DEFAULT 0"),
                ),
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
                ON memory_entries (persona_id, namespace, entry_id DESC)
                """
            )

    @staticmethod
    def _ensure_columns(
        connection: sqlite3.Connection,
        table: str,
        columns: tuple[tuple[str, str], ...],
    ) -> None:
        """Add any missing columns to ``table`` (SQLite has no ADD COLUMN IF NOT
        EXISTS). Existing rows take the column default; this never rewrites data."""
        existing = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
        for name, definition in columns:
            if name not in existing:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")

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
            reinforcement_count=int(row["reinforcement_count"]) if "reinforcement_count" in row.keys() else 1,
            superseded=bool(row["superseded"]) if "superseded" in row.keys() else False,
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

    @staticmethod
    def _select_within_token_budget(
        scored_entries: list[tuple[float, MemoryEntryRecord]],
        *,
        max_entries: int,
        token_budget: int,
    ) -> tuple[MemoryEntryRecord, ...]:
        # Walk highest-scored first, including entries until the estimated token
        # cost would exceed the budget (or the entry cap is hit). The top entry is
        # always admitted even if it alone exceeds the budget, so a single large
        # durable fact is never silently dropped. A budget of 0 disables trimming
        # and the entry cap alone applies.
        selected: list[MemoryEntryRecord] = []
        spent = 0
        for _, entry in scored_entries:
            if max_entries and len(selected) >= max_entries:
                break
            cost = _estimate_tokens(f"{entry.summary} {entry.content}") + _ENTRY_PROMPT_OVERHEAD_TOKENS
            if token_budget and selected and spent + cost > token_budget:
                continue
            selected.append(entry)
            spent += cost
        return tuple(selected)


def build_companion_memory_service(app_paths: AppPaths | None = None) -> CompanionMemoryService:
    resolved_paths = app_paths or get_app_paths()
    return SqliteCompanionMemoryService(
        database_path=resolved_paths.local_data_root / "memory" / "companion-memory.sqlite3"
    )