from __future__ import annotations

from dataclasses import dataclass, field
import json
import time
from pathlib import Path
from typing import Any, Protocol
from urllib import error as urllib_error
from urllib import request as urllib_request

from app.core.settings import AppPaths, get_app_paths
from app.schemas.session import AssistantMessageContract, LLM_BASELINE_PROFILE_IDS
from app.services.resource_monitor import get_resource_monitor


OLLAMA_GENERATE_PATH = "/api/generate"
DEFAULT_OLLAMA_MODEL_DIRECTORY = "ollama-llama3.1-8b"
DEFAULT_OLLAMA_MODEL_NAME = "llama3.1:8b"
DEFAULT_OLLAMA_REQUEST_TIMEOUT_SECONDS = 90
RUNTIME_CONFIG_FILE_NAME = "runtime.json"


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
    timeout_seconds: int = DEFAULT_OLLAMA_REQUEST_TIMEOUT_SECONDS


class TextGenerationInvocationError(RuntimeError):
    """Raised when the local text-generation runtime cannot complete a request."""


def _read_runtime_config(*roots: Path) -> dict[str, Any]:
    for root in roots:
        config_path = root / RUNTIME_CONFIG_FILE_NAME
        if not config_path.is_file():
            continue

        try:
            decoded = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        if isinstance(decoded, dict):
            return decoded

    return {}


def _normalize_model_name(raw_value: Any) -> str:
    if isinstance(raw_value, str) and raw_value.strip():
        return raw_value.strip()

    return DEFAULT_OLLAMA_MODEL_NAME


def _coerce_int(raw_value: Any, default: int) -> int:
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        return default


def _normalize_contract_status(raw_status: Any, *, has_reply_text: bool) -> str:
    normalized = str(raw_status or "").strip().lower()
    if normalized in {"unavailable", "missing", "not_configured"}:
        return "unavailable"

    if normalized in {"degraded"}:
        return "degraded"

    if normalized in {"error", "failed"}:
        return "error"

    if normalized in {"ready", "ok", "success", "completed"}:
        return "ready" if has_reply_text else "error"

    return "ready" if has_reply_text else "error"


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


def _read_json_response(url: str, payload: dict[str, Any], *, timeout_seconds: int = DEFAULT_OLLAMA_REQUEST_TIMEOUT_SECONDS) -> dict[str, Any]:
    request = urllib_request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(request, timeout=max(1, timeout_seconds)) as response:
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
            LLM_BASELINE_PROFILE_IDS[0]: DEFAULT_OLLAMA_MODEL_DIRECTORY,
        }
    )

    def binding_for(self, request: TextGenerationRequest) -> TextGenerationRuntimeBinding:
        provider_root = self.app_paths.providers_root / "llm" / "ollama"
        model_root = self.app_paths.llm_models_root / self.model_directories.get(
            request.profile_id,
            DEFAULT_OLLAMA_MODEL_DIRECTORY,
        )
        runtime_config = _read_runtime_config(model_root, provider_root)
        endpoint = _normalize_endpoint(runtime_config.get("endpoint"))
        model_name = _normalize_model_name(runtime_config.get("model"))
        configured = provider_root.exists() and model_root.exists()

        return TextGenerationRuntimeBinding(
            profile_id=request.profile_id,
            family="ollama",
            provider_root=provider_root,
            model_root=model_root,
            endpoint=endpoint,
            model_name=model_name,
            configured=configured,
            timeout_seconds=max(1, _coerce_int(runtime_config.get("timeout_seconds"), DEFAULT_OLLAMA_REQUEST_TIMEOUT_SECONDS)),
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
        tracker = get_resource_monitor().tracker("llm")

        if not binding.configured:
            return self._build_contract(
                request,
                status="unavailable",
                text=self.unavailable_text,
            )

        start_time = time.time()
        try:
            response = _read_json_response(
                binding.endpoint,
                {
                    "model": binding.model_name,
                    "prompt": request.prompt,
                    "stream": False,
                },
                timeout_seconds=binding.timeout_seconds,
            )
        except TextGenerationInvocationError as error:
            status = "unavailable" if str(error) == "connection-failed" else "error"
            return self._build_contract(
                request,
                status=status,
                text=self.unavailable_text if status == "unavailable" else "Local text generation failed.",
            )

        elapsed_ms = (time.time() - start_time) * 1000

        # Mark LLM as loaded on first successful response
        if not tracker.loaded:
            # Ollama llama3.1:8b Q4 uses ~5-6GB VRAM
            tracker.mark_loaded(f"ollama/{binding.model_name}", vram_mb=5500, ram_mb=1024)
        tracker.record_request(elapsed_ms)

        reply_text = str(response.get("response") or response.get("text") or "").strip()
        if not reply_text:
            return self._build_contract(
                request,
                status="error",
                text="Local text generation returned no reply.",
            )

        return self._build_contract(
            request,
            status=_normalize_contract_status(response.get("status"), has_reply_text=True),
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