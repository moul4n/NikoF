"""Operator-editable global character profile routes.

A single shared profile (personality, do's, don'ts, response/TTS formatting)
edited on the control page and applied to whichever character is active. Stored
in the companion-memory DB via the memory service; injected into the planner
prompt each turn (see turns_prompts._character_profile_lines).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.companion_memory import CharacterProfileRecord, CompanionMemoryService


@dataclass(slots=True, frozen=True)
class CharacterProfileUpdateRequest:
    personality: str = ""
    directives_do: str = ""
    directives_dont: str = ""
    response_formatting: str = ""


def _serialize(record: CharacterProfileRecord) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "personality": record.personality,
        "directives_do": record.directives_do,
        "directives_dont": record.directives_dont,
        "response_formatting": record.response_formatting,
        "updated_at": record.updated_at,
    }


def register_character_profile_routes(
    router: Any,
    *,
    memory_service: CompanionMemoryService | None,
) -> None:
    from fastapi import HTTPException, status

    def _require_service() -> CompanionMemoryService:
        if memory_service is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Memory service is unavailable; cannot load the character profile.",
            )
        return memory_service

    @router.get("/session/character-profile")
    async def get_session_character_profile() -> dict[str, Any]:
        return _serialize(_require_service().get_character_profile())

    @router.put("/session/character-profile")
    async def put_session_character_profile(update: CharacterProfileUpdateRequest) -> dict[str, Any]:
        record = _require_service().set_character_profile(
            personality=update.personality,
            directives_do=update.directives_do,
            directives_dont=update.directives_dont,
            response_formatting=update.response_formatting,
        )
        return _serialize(record)
