from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import json
import logging
import os
import subprocess
import time
from pathlib import Path
import re
import threading
from typing import Any, Iterator
from urllib.parse import urlparse

from app.core.settings import AppPaths, get_app_paths
from app.services.streaming_reply import ReplyTextStreamExtractor
from app.schemas.session import (
    AssistantMessageContract,
    LLM_BASELINE_PROFILE_IDS,
)
from app.services.resource_monitor import get_resource_monitor
from app.services.process_supervision import find_listening_pid, terminate_process_tree, terminate_process_tree_by_pid
# Core contracts (extracted to a leaf module). Re-exported so callers/tests keep
# importing them from app.services.llm.
from app.services.llm_contracts import (  # noqa: F401  (re-exported for callers)
    TextGenerationInvocationError,
    TextGenerationRequest,
    TextGenerationService,
    TextGenerationStreamEvent,
)
# Structured-output parsing (extracted); used by the Ollama adapter below.
from app.services.llm_parsing import (
    _extract_json_object,
    _normalize_contract_status,
    _normalize_structured_contract,
)
# Ollama runtime config constants + HTTP/transport helpers (extracted). Used by
# the binding/adapter/sidecar below; re-exported for callers/tests.
from app.services.llm_runtime import (  # noqa: F401  (re-exported for callers)
    DEFAULT_OLLAMA_BASE_URL,
    DEFAULT_OLLAMA_HEALTH_TIMEOUT_SECONDS,
    DEFAULT_OLLAMA_MODEL_DIRECTORY,
    DEFAULT_OLLAMA_MODEL_NAME,
    DEFAULT_OLLAMA_REQUEST_TIMEOUT_SECONDS,
    DEFAULT_OLLAMA_STARTUP_TIMEOUT_SECONDS,
    OLLAMA_GENERATE_PATH,
    OLLAMA_HEALTH_PATH,
    OLLAMA_STARTUP_POLL_INTERVAL_SECONDS,
    RUNTIME_CONFIG_FILE_NAME,
    _build_default_ollama_serve_command,
    _coerce_bool,
    _coerce_float,
    _coerce_int,
    _normalize_base_url,
    _normalize_command,
    _normalize_endpoint,
    _normalize_health_url,
    _normalize_model_name,
    _read_health_response,
    _read_json_response,
    _read_ndjson_stream,
    _read_runtime_config,
    _resolve_profile_family,
)


logger = logging.getLogger(__name__)


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
    health_url: str | None = None
    manage_process: bool = False
    startup_timeout_seconds: float = DEFAULT_OLLAMA_STARTUP_TIMEOUT_SECONDS
    health_timeout_seconds: float = DEFAULT_OLLAMA_HEALTH_TIMEOUT_SECONDS
    serve_command: tuple[str, ...] = ()
    working_directory: Path | None = None


class TextGenerationSidecarState(str, Enum):
    IDLE = "idle"
    READY = "ready"
    UNAVAILABLE = "unavailable"
    ERROR = "error"


@dataclass(slots=True)
class TextGenerationSidecarStatus:
    state: TextGenerationSidecarState
    profile_id: str
    family: str | None
    configured: bool
    available: bool
    loaded: bool
    model_name: str | None
    endpoint: str | None
    timeout_seconds: int | None
    last_error: str | None
    requests_processed: int
    average_latency_ms: float | None
    last_request_epoch: float | None
    vram_allocated_mb: float | None
    ram_allocated_mb: float | None
    process_managed: bool
    process_running: bool
    process_healthy: bool
    started_by_backend: bool
    owner_pid: int | None
    health_url: str | None
    startup_timeout_seconds: float | None
    stdout_log_path: str | None
    stderr_log_path: str | None


def _optional_generate_params() -> dict[str, Any]:
    """Optional Ollama /api/generate params from env. NIKOF_LLM_THINK toggles a
    reasoning model's thinking (e.g. qwen3) — set it false for fast, clean JSON
    planner output during speed testing."""
    raw = os.environ.get("NIKOF_LLM_THINK")
    if raw is None or not raw.strip():
        return {}
    return {"think": raw.strip().lower() in {"1", "true", "yes", "on"}}


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

    def generate_stream(self, request: TextGenerationRequest) -> Iterator[TextGenerationStreamEvent]:
        """Non-streaming fallback: produce the whole reply as one final event."""
        contract = self.generate(request)
        yield TextGenerationStreamEvent(text_delta=contract.text, contract=contract)


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
        health_url = _normalize_health_url(
            runtime_config.get("health_url") or runtime_config.get("health_endpoint"),
            endpoint=endpoint,
        )
        model_name = os.environ.get("NIKOF_LLM_MODEL", "").strip() or _normalize_model_name(
            runtime_config.get("model")
        )
        configured = provider_root.exists() and model_root.exists()
        manage_process = _coerce_bool(
            runtime_config.get("manage_process")
            if "manage_process" in runtime_config
            else runtime_config.get("backend_managed"),
            default=False,
        )
        serve_command = _normalize_command(runtime_config.get("serve_command")) or _build_default_ollama_serve_command()
        working_directory = provider_root if provider_root.exists() else self.app_paths.repo_root

        return TextGenerationRuntimeBinding(
            profile_id=request.profile_id,
            family="ollama",
            provider_root=provider_root,
            model_root=model_root,
            endpoint=endpoint,
            model_name=model_name,
            configured=configured,
            timeout_seconds=max(1, _coerce_int(runtime_config.get("timeout_seconds"), DEFAULT_OLLAMA_REQUEST_TIMEOUT_SECONDS)),
            health_url=health_url,
            manage_process=manage_process,
            startup_timeout_seconds=_coerce_float(
                runtime_config.get("startup_timeout_seconds"),
                DEFAULT_OLLAMA_STARTUP_TIMEOUT_SECONDS,
            ),
            health_timeout_seconds=_coerce_float(
                runtime_config.get("health_timeout_seconds"),
                DEFAULT_OLLAMA_HEALTH_TIMEOUT_SECONDS,
            ),
            serve_command=serve_command,
            working_directory=working_directory,
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
                    **({"format": "json"} if request.expect_structured_output else {}),
                    **_optional_generate_params(),
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

        if request.expect_structured_output:
            structured_payload = _extract_json_object(reply_text)
            if structured_payload is not None:
                try:
                    contract = _normalize_structured_contract(request, structured_payload)
                except TextGenerationInvocationError:
                    pass
                else:
                    return contract

        return self._build_contract(
            request,
            status=_normalize_contract_status(response.get("status"), has_reply_text=True),
            text=reply_text,
        )

    def _finalize_completion(self, request: TextGenerationRequest, completion_text: str) -> AssistantMessageContract:
        reply_text = completion_text.strip()
        if not reply_text:
            return self._build_contract(request, status="error", text="Local text generation returned no reply.")
        if request.expect_structured_output:
            structured_payload = _extract_json_object(reply_text)
            if structured_payload is not None:
                try:
                    return _normalize_structured_contract(request, structured_payload)
                except TextGenerationInvocationError:
                    pass
        return self._build_contract(
            request,
            status=_normalize_contract_status(None, has_reply_text=True),
            text=reply_text,
        )

    def generate_stream(self, request: TextGenerationRequest) -> Iterator[TextGenerationStreamEvent]:
        binding = self.binding_for(request)
        tracker = get_resource_monitor().tracker("llm")

        if not binding.configured:
            yield TextGenerationStreamEvent(
                contract=self._build_contract(request, status="unavailable", text=self.unavailable_text)
            )
            return

        payload: dict[str, Any] = {
            "model": binding.model_name,
            "prompt": request.prompt,
            "stream": True,
            **({"format": "json"} if request.expect_structured_output else {}),
            **_optional_generate_params(),
        }
        extractor = ReplyTextStreamExtractor()
        completion_parts: list[str] = []
        start_time = time.time()

        try:
            for line in _read_ndjson_stream(binding.endpoint, payload, timeout_seconds=binding.timeout_seconds):
                fragment = str(line.get("response") or "")
                if fragment:
                    completion_parts.append(fragment)
                    delta = extractor.feed(fragment)
                    if delta:
                        yield TextGenerationStreamEvent(text_delta=delta)
                if line.get("done"):
                    break
        except TextGenerationInvocationError as error:
            status = "unavailable" if str(error) == "connection-failed" else "error"
            text = self.unavailable_text if status == "unavailable" else "Local text generation failed."
            yield TextGenerationStreamEvent(contract=self._build_contract(request, status=status, text=text))
            return

        elapsed_ms = (time.time() - start_time) * 1000
        if not tracker.loaded:
            tracker.mark_loaded(f"ollama/{binding.model_name}", vram_mb=5500, ram_mb=1024)
        tracker.record_request(elapsed_ms)

        yield TextGenerationStreamEvent(
            contract=self._finalize_completion(request, "".join(completion_parts))
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


class ManagedTextGenerationService:
    """Thin wrapper that keeps provider-specific generation behind a managed boundary."""

    def __init__(self, manager: TextGenerationSidecarManager, delegate: TextGenerationService) -> None:
        self._manager = manager
        self._delegate = delegate

    def generate(self, request: TextGenerationRequest) -> AssistantMessageContract:
        binding = self._manager.binding_for(self._delegate, request)
        preflight_contract = self._manager.prepare_request(request=request, binding=binding)
        if preflight_contract is not None:
            if binding is not None:
                self._manager.observe_result(request=request, binding=binding, contract=preflight_contract)
            return preflight_contract
        contract = self._delegate.generate(request)
        self._manager.observe_result(request=request, binding=binding, contract=contract)
        return contract

    def generate_stream(self, request: TextGenerationRequest) -> Iterator[TextGenerationStreamEvent]:
        binding = self._manager.binding_for(self._delegate, request)
        preflight_contract = self._manager.prepare_request(request=request, binding=binding)
        if preflight_contract is not None:
            if binding is not None:
                self._manager.observe_result(request=request, binding=binding, contract=preflight_contract)
            yield TextGenerationStreamEvent(text_delta=preflight_contract.text, contract=preflight_contract)
            return

        delegate_stream = getattr(self._delegate, "generate_stream", None)
        if delegate_stream is None:
            contract = self._delegate.generate(request)
            self._manager.observe_result(request=request, binding=binding, contract=contract)
            yield TextGenerationStreamEvent(text_delta=contract.text, contract=contract)
            return

        final_contract: AssistantMessageContract | None = None
        for event in delegate_stream(request):
            if event.contract is not None:
                final_contract = event.contract
            yield event
        if final_contract is not None:
            self._manager.observe_result(request=request, binding=binding, contract=final_contract)


class TextGenerationSidecarManager:
    """Owns the backend-facing LLM lifecycle, health, and provider resolution boundary."""

    def __init__(
        self,
        *,
        app_paths: AppPaths | None = None,
        registry: TextGenerationServiceRegistry | None = None,
    ) -> None:
        self._app_paths = app_paths or get_app_paths()
        self._registry = registry or build_text_generation_service_registry(self._app_paths)
        self._state = TextGenerationSidecarState.IDLE
        self._last_error: str | None = None
        self._last_binding: TextGenerationRuntimeBinding | None = None
        self._wrapped_services: dict[int, ManagedTextGenerationService] = {}
        self._process: subprocess.Popen[str] | None = None
        self._stdout_log_path: Path | None = None
        self._stderr_log_path: Path | None = None
        self._started_by_backend = False
        self._lock = threading.Lock()

    @property
    def owner_pid(self) -> int | None:
        return None if self._process is None else self._process.pid

    def _is_process_running_unlocked(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _log_root(self) -> Path:
        return self._app_paths.local_data_root / "logs" / "llm"

    def _healthcheck(self, binding: TextGenerationRuntimeBinding) -> bool:
        if binding.health_url is None:
            return False

        try:
            _read_health_response(binding.health_url, timeout_seconds=binding.health_timeout_seconds)
        except TextGenerationInvocationError:
            return False
        return True

    def _wait_for_healthy(self, binding: TextGenerationRuntimeBinding) -> bool:
        deadline = time.monotonic() + max(0.5, binding.startup_timeout_seconds)
        while time.monotonic() < deadline:
            with self._lock:
                if self._process is not None and self._process.poll() is not None:
                    return False
            if self._healthcheck(binding):
                return True
            time.sleep(OLLAMA_STARTUP_POLL_INTERVAL_SECONDS)
        return False

    def _terminate_owned_process_unlocked(self) -> None:
        if self._process is None:
            self._started_by_backend = False
            return

        terminate_process_tree(self._process)
        self._process = None
        self._started_by_backend = False

    def _resolve_listener_host_port(self, binding: TextGenerationRuntimeBinding) -> tuple[str, int] | None:
        candidate_url = binding.health_url or binding.endpoint
        if not candidate_url:
            return None

        parsed = urlparse(candidate_url)
        if parsed.hostname is None or parsed.port is None:
            return None

        return parsed.hostname, parsed.port

    def _reclaim_external_listener(self, binding: TextGenerationRuntimeBinding) -> bool:
        listener = self._resolve_listener_host_port(binding)
        if listener is None:
            return False

        host, port = listener
        external_pid = find_listening_pid(host, port)
        if external_pid is None:
            return not self._healthcheck(binding)

        logger.warning(
            "Reclaiming external LLM listener pid=%s on %s before backend-owned startup",
            external_pid,
            binding.health_url or binding.endpoint,
        )
        terminate_process_tree_by_pid(external_pid)

        deadline = time.monotonic() + max(0.5, binding.health_timeout_seconds + 2.0)
        while time.monotonic() < deadline:
            if not self._healthcheck(binding):
                return True
            time.sleep(OLLAMA_STARTUP_POLL_INTERVAL_SECONDS)
        return False

    def _start_process_unlocked(self, binding: TextGenerationRuntimeBinding) -> bool:
        command = tuple(binding.serve_command)
        if not command:
            self._last_error = "LLM sidecar command is not configured."
            return False

        self._log_root().mkdir(parents=True, exist_ok=True)
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        self._stdout_log_path = self._log_root() / f"llm-sidecar-{timestamp}.stdout.log"
        self._stderr_log_path = self._log_root() / f"llm-sidecar-{timestamp}.stderr.log"

        env = {
            **os.environ,
            "NIKOF_LLM_OWNER_PID": str(os.getpid()),
            "NIKOF_BACKEND_ROOT": str(Path(__file__).resolve().parents[2]),
        }

        try:
            with self._stdout_log_path.open("a", encoding="utf-8") as stdout_log:
                with self._stderr_log_path.open("a", encoding="utf-8") as stderr_log:
                    self._process = subprocess.Popen(
                        list(command),
                        stdout=stdout_log,
                        stderr=stderr_log,
                        text=True,
                        cwd=str(binding.working_directory or binding.provider_root or self._app_paths.repo_root),
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                        env=env,
                    )
        except OSError as exc:
            self._process = None
            self._started_by_backend = False
            self._last_error = f"LLM sidecar failed to start: {exc}"
            logger.error("Failed to start LLM sidecar: %s", exc)
            return False

        self._started_by_backend = True
        self._last_error = None
        return True

    def _ensure_process_running(self, binding: TextGenerationRuntimeBinding) -> bool:
        if not binding.manage_process:
            return True

        if self._healthcheck(binding):
            with self._lock:
                owns_running_process = self._is_process_running_unlocked()
                self._started_by_backend = owns_running_process
            if owns_running_process:
                return True
            if not self._reclaim_external_listener(binding):
                with self._lock:
                    self._last_error = "Existing external LLM listener could not be reclaimed for backend ownership."
                return False

        with self._lock:
            if self._is_process_running_unlocked():
                self._terminate_owned_process_unlocked()

            if not self._start_process_unlocked(binding):
                return False

        if self._wait_for_healthy(binding):
            return True

        with self._lock:
            self._terminate_owned_process_unlocked()
            self._last_error = "LLM sidecar failed to become healthy."
        return False

    def prepare_request(
        self,
        *,
        request: TextGenerationRequest,
        binding: TextGenerationRuntimeBinding | None,
    ) -> AssistantMessageContract | None:
        if binding is None or not binding.manage_process:
            return None

        if not binding.configured:
            return None

        if self._ensure_process_running(binding):
            return None

        return AssistantMessageContract(
            profile_id=request.profile_id,
            status="unavailable",
            text="Local text generation sidecar failed to start.",
            locale=request.locale,
        )

    def start(self, request: TextGenerationRequest | None = None) -> bool:
        resolved_request = request or TextGenerationRequest(prompt="", locale="en-US")
        delegate = self._registry.resolve(resolved_request)
        binding = self.binding_for(delegate, resolved_request)
        if binding is None or not binding.manage_process or not binding.configured:
            return False
        with self._lock:
            self._last_binding = binding
        return self._ensure_process_running(binding)

    def stop(self) -> None:
        with self._lock:
            self._terminate_owned_process_unlocked()

    def restart(self, request: TextGenerationRequest | None = None) -> bool:
        self.stop()
        return self.start(request)

    def warmup(self, request: TextGenerationRequest | None = None) -> AssistantMessageContract:
        resolved_request = request or TextGenerationRequest(
            prompt="Reply with the single word READY.",
            locale="en-US",
        )
        return self.resolve(resolved_request).generate(resolved_request)

    def binding_for(
        self,
        service: TextGenerationService,
        request: TextGenerationRequest,
    ) -> TextGenerationRuntimeBinding | None:
        binding_for = getattr(service, "binding_for", None)
        if not callable(binding_for):
            return None

        binding = binding_for(request)
        if isinstance(binding, TextGenerationRuntimeBinding):
            return binding
        return None

    def resolve(self, request: TextGenerationRequest) -> TextGenerationService:
        delegate = self._registry.resolve(request)
        binding = self.binding_for(delegate, request)
        if binding is not None:
            with self._lock:
                self._last_binding = binding

        key = id(delegate)
        with self._lock:
            wrapped = self._wrapped_services.get(key)
            if wrapped is None:
                wrapped = ManagedTextGenerationService(self, delegate)
                self._wrapped_services[key] = wrapped
            return wrapped

    def observe_result(
        self,
        *,
        request: TextGenerationRequest,
        binding: TextGenerationRuntimeBinding | None,
        contract: AssistantMessageContract,
    ) -> None:
        tracker_snapshot = get_resource_monitor().tracker("llm").snapshot()
        with self._lock:
            if binding is not None:
                self._last_binding = binding

            if contract.status in {"ready", "degraded"}:
                self._state = TextGenerationSidecarState.READY
                self._last_error = None
                return

            if contract.status == "unavailable":
                self._state = TextGenerationSidecarState.UNAVAILABLE
                if binding is not None and not binding.configured:
                    self._last_error = "LLM runtime is not configured."
                elif self._last_error is not None:
                    pass
                elif tracker_snapshot.loaded:
                    self._last_error = contract.text
                else:
                    self._last_error = contract.text or "LLM sidecar is unavailable."
                return

            self._state = TextGenerationSidecarState.ERROR
            self._last_error = contract.text or "LLM sidecar request failed."

    def status(self, request: TextGenerationRequest | None = None) -> TextGenerationSidecarStatus:
        resolved_request = request or TextGenerationRequest(
            prompt="",
            locale="en-US",
            profile_id=LLM_BASELINE_PROFILE_IDS[0],
        )
        delegate = self._registry.resolve(resolved_request)
        binding = self.binding_for(delegate, resolved_request) or self._last_binding
        tracker_snapshot = get_resource_monitor().tracker("llm").snapshot()

        state = self._state
        if tracker_snapshot.loaded and state == TextGenerationSidecarState.IDLE:
            state = TextGenerationSidecarState.READY

        configured = binding.configured if binding is not None else False
        process_managed = binding.manage_process if binding is not None else False
        process_running = False
        started_by_backend = False
        owner_pid = None
        if process_managed:
            with self._lock:
                process_running = self._is_process_running_unlocked()
                started_by_backend = self._started_by_backend
                owner_pid = self.owner_pid

        process_healthy = process_managed and process_running
        available = configured and (
            process_healthy if process_managed else state in {TextGenerationSidecarState.IDLE, TextGenerationSidecarState.READY}
        )
        family = binding.family if binding is not None else None
        model_name = binding.model_name if binding is not None else None
        endpoint = binding.endpoint if binding is not None else None
        timeout_seconds = binding.timeout_seconds if binding is not None else None

        return TextGenerationSidecarStatus(
            state=state,
            profile_id=resolved_request.profile_id,
            family=family,
            configured=configured,
            available=available,
            loaded=tracker_snapshot.loaded,
            model_name=model_name,
            endpoint=endpoint,
            timeout_seconds=timeout_seconds,
            last_error=self._last_error,
            requests_processed=tracker_snapshot.requests_processed,
            average_latency_ms=tracker_snapshot.average_latency_ms,
            last_request_epoch=tracker_snapshot.last_request_epoch,
            vram_allocated_mb=tracker_snapshot.vram_allocated_mb,
            ram_allocated_mb=tracker_snapshot.ram_allocated_mb,
            process_managed=process_managed,
            process_running=process_running,
            process_healthy=process_healthy,
            started_by_backend=started_by_backend,
            owner_pid=owner_pid,
            health_url=binding.health_url if binding is not None else None,
            startup_timeout_seconds=binding.startup_timeout_seconds if binding is not None else None,
            stdout_log_path=None if self._stdout_log_path is None else str(self._stdout_log_path),
            stderr_log_path=None if self._stderr_log_path is None else str(self._stderr_log_path),
        )


def build_text_generation_sidecar_manager(
    app_paths: AppPaths | None = None,
) -> TextGenerationSidecarManager:
    resolved_paths = app_paths or get_app_paths()
    return TextGenerationSidecarManager(app_paths=resolved_paths)


_text_generation_sidecar_manager: TextGenerationSidecarManager | None = None
_text_generation_sidecar_lock = threading.Lock()


def get_text_generation_sidecar_manager(
    app_paths: AppPaths | None = None,
) -> TextGenerationSidecarManager:
    global _text_generation_sidecar_manager

    resolved_paths = app_paths or get_app_paths()
    with _text_generation_sidecar_lock:
        if _text_generation_sidecar_manager is None:
            _text_generation_sidecar_manager = build_text_generation_sidecar_manager(resolved_paths)
        elif app_paths is not None:
            current_paths = _text_generation_sidecar_manager._app_paths
            if (
                current_paths.providers_root != resolved_paths.providers_root
                or current_paths.llm_models_root != resolved_paths.llm_models_root
            ):
                logger.warning("LLM sidecar app paths changed; stopping previous manager before swap")
                try:
                    _text_generation_sidecar_manager.stop()
                except Exception:
                    logger.exception("Failed to stop previous LLM sidecar during manager swap")
                _text_generation_sidecar_manager = build_text_generation_sidecar_manager(resolved_paths)

    return _text_generation_sidecar_manager