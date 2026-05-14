from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
from typing import Any, Protocol
from urllib import error as urllib_error
from urllib import request as urllib_request

from app.core.settings import AppPaths, get_app_paths
from app.schemas.session import AssistantMessageContract, LLM_BASELINE_PROFILE_IDS


OLLAMA_GENERATE_PATH = "/api/generate"


@dataclass(slots=True, frozen=True)
class TextGenerationRequest:
    prompt: str
    locale: str
    profile_id: str = LLM_BASELINE_PROFILE_IDS[0]


class TextGenerationService(Protocol):
    """Boundary for provider-agnostic local text-generation adapters."""

    def generate(self, request: TextGenerationRequest) -> AssistantMessageContract:
        raise NotImplementedError


@dataclass(slots=True, frozen=True)
class TextGenerationRuntimeBinding:
    profile_id: str
    family: str
    provider_root: Path
    model_root: Path
    endpoint: str
    model_name: str
    configured: bool


class TextGenerationInvocationError(RuntimeError):
    """Raised when the local text-generation runtime cannot complete a request."""


def _resolve_profile_family(profile_id: str) -> str:
    _, separator, remainder = profile_id.partition(".")
    if not separator:
        return profile_id

    family, _, _ = remainder.partition(".")
    return family or profile_id


def _normalize_endpoint(raw_value: str | None) -> str:
    if raw_value is None or not raw_value.strip():
        return f"http://127.0.0.1:11434{OLLAMA_GENERATE_PATH}"

    normalized = raw_value.strip().rstrip("/")
    if normalized.endswith(OLLAMA_GENERATE_PATH):
        return normalized

    return f"{normalized}{OLLAMA_GENERATE_PATH}"


def _read_json_response(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib_request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(request, timeout=10) as response:
            raw_response = response.read().decode("utf-8")
    except (urllib_error.URLError, TimeoutError) as exc:
        raise TextGenerationInvocationError("connection-failed") from exc

    try:
        decoded = json.loads(raw_response)
    except json.JSONDecodeError as exc:
        raise TextGenerationInvocationError("invalid-json") from exc

    if not isinstance(decoded, dict):
        raise TextGenerationInvocationError("invalid-payload")

    return decoded


@dataclass(slots=True)
class StubTextGenerationService:
    """Deterministic fallback while no local LLM runtime is configured."""

    unavailable_text: str = "Local text generation is unavailable."

    def generate(self, request: TextGenerationRequest) -> AssistantMessageContract:
        return AssistantMessageContract(
            profile_id=request.profile_id,
            status="unavailable",
            text=self.unavailable_text,
            locale=request.locale,
        )


@dataclass(slots=True)
class OllamaTextGenerationAdapter(StubTextGenerationService):
    """Minimal real local text-generation path through an Ollama runtime."""

    app_paths: AppPaths = field(default_factory=get_app_paths)
    model_directories: dict[str, str] = field(
        default_factory=lambda: {
            LLM_BASELINE_PROFILE_IDS[0]: "ollama-llama3.1-8b",
        }
    )
    model_names: dict[str, str] = field(
        default_factory=lambda: {
            LLM_BASELINE_PROFILE_IDS[0]: os.environ.get("NIKOF_OLLAMA_MODEL", "llama3.1:8b"),
        }
    )

    def binding_for(self, request: TextGenerationRequest) -> TextGenerationRuntimeBinding:
        provider_root = self.app_paths.providers_root / "llm" / "ollama"
        model_root = self.app_paths.llm_models_root / self.model_directories.get(
            request.profile_id,
            "ollama-llama3.1-8b",
        )
        endpoint = _normalize_endpoint(
            os.environ.get("NIKOF_OLLAMA_ENDPOINT") or os.environ.get("OLLAMA_HOST")
        )
        model_name = self.model_names.get(
            request.profile_id,
            os.environ.get("NIKOF_OLLAMA_MODEL", "llama3.1:8b"),
        )
        configured = any(
            (
                provider_root.exists(),
                model_root.exists(),
                bool(os.environ.get("NIKOF_OLLAMA_MODEL")),
                bool(os.environ.get("NIKOF_OLLAMA_ENDPOINT")),
                bool(os.environ.get("OLLAMA_HOST")),
            )
        )

        return TextGenerationRuntimeBinding(
            profile_id=request.profile_id,
            family="ollama",
            provider_root=provider_root,
            model_root=model_root,
            endpoint=endpoint,
            model_name=model_name,
            configured=configured,
        )

    def _build_contract(
        self,
        request: TextGenerationRequest,
        *,
        status: str,
        text: str,
    ) -> AssistantMessageContract:
        return AssistantMessageContract(
            profile_id=request.profile_id,
            status=status,
            text=text,
            locale=request.locale,
        )

    def generate(self, request: TextGenerationRequest) -> AssistantMessageContract:
        binding = self.binding_for(request)
        if not binding.configured:
            return self._build_contract(
                request,
                status="unavailable",
                text=self.unavailable_text,
            )

        try:
            response = _read_json_response(
                binding.endpoint,
                {
                    "model": binding.model_name,
                    "prompt": request.prompt,
                    "stream": False,
                },
            )
        except TextGenerationInvocationError:
            return self._build_contract(
                request,
                status="error",
                text="Local text generation failed.",
            )

        reply_text = str(response.get("response") or "").strip()
        if not reply_text:
            return self._build_contract(
                request,
                status="error",
                text="Local text generation returned no reply.",
            )

        return self._build_contract(
            request,
            status=str(response.get("status") or "ready"),
            text=reply_text,
        )


@dataclass(slots=True)
class TextGenerationServiceRegistry:
    """Minimal profile-family registry for provider-agnostic text generation."""

    text_generation_services: dict[str, TextGenerationService] = field(default_factory=dict)
    fallback_text_generation_service: TextGenerationService = field(
        default_factory=StubTextGenerationService
    )

    def resolve(self, request: TextGenerationRequest) -> TextGenerationService:
        return self.text_generation_services.get(
            _resolve_profile_family(request.profile_id),
            self.fallback_text_generation_service,
        )


def build_text_generation_service_registry(
    app_paths: AppPaths | None = None,
) -> TextGenerationServiceRegistry:
    resolved_paths = app_paths or get_app_paths()
    return TextGenerationServiceRegistry(
        text_generation_services={
            "ollama": OllamaTextGenerationAdapter(app_paths=resolved_paths),
        }
    )