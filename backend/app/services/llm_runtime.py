"""Ollama runtime config + HTTP transport helpers (extracted from llm.py).

The provider config constants and the leaf utilities the Ollama adapter and
sidecar manager share: runtime.json reading, value/URL/command normalization,
and the /api health + generate (incl. NDJSON streaming) HTTP calls. Imports
only the leaf contracts (for the invocation error); llm.py re-exports these.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator
from urllib import error as urllib_error
from urllib import request as urllib_request

from app.services.llm_contracts import TextGenerationInvocationError


OLLAMA_GENERATE_PATH = "/api/generate"
OLLAMA_HEALTH_PATH = "/api/tags"
DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_MODEL_DIRECTORY = "ollama-llama3.1-8b"
DEFAULT_OLLAMA_MODEL_NAME = "llama3.1:8b"
DEFAULT_OLLAMA_REQUEST_TIMEOUT_SECONDS = 90
DEFAULT_OLLAMA_STARTUP_TIMEOUT_SECONDS = 30.0
DEFAULT_OLLAMA_HEALTH_TIMEOUT_SECONDS = 2.0
OLLAMA_STARTUP_POLL_INTERVAL_SECONDS = 0.5
RUNTIME_CONFIG_FILE_NAME = "runtime.json"
def _read_runtime_config(*roots: Path) -> dict[str, Any]:
    merged_config: dict[str, Any] = {}
    for root in roots:
        config_path = root / RUNTIME_CONFIG_FILE_NAME
        if not config_path.is_file():
            continue

        try:
            decoded = json.loads(config_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue

        if isinstance(decoded, dict):
            merged_config.update(decoded)

    return merged_config


def _normalize_model_name(raw_value: Any) -> str:
    if isinstance(raw_value, str) and raw_value.strip():
        return raw_value.strip()

    return DEFAULT_OLLAMA_MODEL_NAME


def _coerce_int(raw_value: Any, default: int) -> int:
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        return default




def _resolve_profile_family(profile_id: str) -> str:
    _, separator, remainder = profile_id.partition(".")
    if not separator:
        return profile_id

    family, _, _ = remainder.partition(".")
    return family or profile_id


def _normalize_endpoint(raw_value: str | None) -> str:
    if raw_value is None or not raw_value.strip():
        return f"{DEFAULT_OLLAMA_BASE_URL}{OLLAMA_GENERATE_PATH}"

    normalized = raw_value.strip().rstrip("/")
    if normalized.endswith(OLLAMA_GENERATE_PATH):
        return normalized

    return f"{normalized}{OLLAMA_GENERATE_PATH}"


def _normalize_base_url(raw_value: str | None) -> str:
    endpoint = _normalize_endpoint(raw_value)
    if endpoint.endswith(OLLAMA_GENERATE_PATH):
        return endpoint[: -len(OLLAMA_GENERATE_PATH)]
    return endpoint.rstrip("/")


def _normalize_health_url(raw_value: str | None, *, endpoint: str) -> str:
    if raw_value is not None and raw_value.strip():
        normalized = raw_value.strip().rstrip("/")
        if normalized.startswith("http://") or normalized.startswith("https://"):
            return normalized
        base_url = _normalize_base_url(endpoint)
        return f"{base_url}{normalized if normalized.startswith('/') else '/' + normalized}"

    return f"{_normalize_base_url(endpoint)}{OLLAMA_HEALTH_PATH}"


def _coerce_float(raw_value: Any, default: float) -> float:
    try:
        parsed = float(raw_value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _coerce_bool(raw_value: Any, default: bool = False) -> bool:
    if isinstance(raw_value, bool):
        return raw_value
    if isinstance(raw_value, (int, float)):
        return bool(raw_value)
    if isinstance(raw_value, str):
        normalized = raw_value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "managed"}:
            return True
        if normalized in {"0", "false", "no", "off", "disabled"}:
            return False
    return default


def _normalize_command(raw_value: Any) -> tuple[str, ...]:
    if isinstance(raw_value, (list, tuple)):
        return tuple(str(part).strip() for part in raw_value if str(part).strip())

    if isinstance(raw_value, str) and raw_value.strip():
        return (raw_value.strip(),)

    return tuple()


def _build_default_ollama_serve_command() -> tuple[str, ...]:
    return ("ollama", "serve")


def _read_health_response(
    url: str,
    *,
    timeout_seconds: float = DEFAULT_OLLAMA_HEALTH_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    request = urllib_request.Request(url, method="GET")

    try:
        with urllib_request.urlopen(request, timeout=max(0.1, timeout_seconds)) as response:
            raw_response = response.read().decode("utf-8")
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        raise TextGenerationInvocationError("connection-failed") from exc

    try:
        decoded = json.loads(raw_response)
    except json.JSONDecodeError as exc:
        raise TextGenerationInvocationError("invalid-json") from exc

    if not isinstance(decoded, dict):
        raise TextGenerationInvocationError("invalid-payload")

    return decoded


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


def _read_ndjson_stream(
    url: str, payload: dict[str, Any], *, timeout_seconds: int = DEFAULT_OLLAMA_REQUEST_TIMEOUT_SECONDS
) -> Iterator[dict[str, Any]]:
    """Yield each NDJSON object from a streaming Ollama /api/generate response."""
    request = urllib_request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(request, timeout=max(1, timeout_seconds)) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    decoded = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(decoded, dict):
                    yield decoded
    except (urllib_error.URLError, TimeoutError) as exc:
        raise TextGenerationInvocationError("connection-failed") from exc
