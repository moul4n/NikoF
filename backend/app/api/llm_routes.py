from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.llm import TextGenerationRequest, TextGenerationSidecarStatus, get_text_generation_sidecar_manager


@dataclass(slots=True, frozen=True)
class LLMStateResponse:
    schema_version: int
    state: str
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


@dataclass(slots=True, frozen=True)
class LLMControlRequest:
    action: str
    locale: str = "en-US"
    profile_id: str = "llm.ollama.llama3.1-8b-2026"
    prompt: str | None = None


def _serialize_state(status: TextGenerationSidecarStatus) -> LLMStateResponse:
    return LLMStateResponse(
        schema_version=1,
        state=status.state.value if hasattr(status.state, "value") else str(status.state),
        profile_id=status.profile_id,
        family=status.family,
        configured=status.configured,
        available=status.available,
        loaded=status.loaded,
        model_name=status.model_name,
        endpoint=status.endpoint,
        timeout_seconds=status.timeout_seconds,
        last_error=status.last_error,
        requests_processed=status.requests_processed,
        average_latency_ms=status.average_latency_ms,
        last_request_epoch=status.last_request_epoch,
        vram_allocated_mb=status.vram_allocated_mb,
        ram_allocated_mb=status.ram_allocated_mb,
        process_managed=status.process_managed,
        process_running=status.process_running,
        process_healthy=status.process_healthy,
        started_by_backend=status.started_by_backend,
        owner_pid=status.owner_pid,
        health_url=status.health_url,
        startup_timeout_seconds=status.startup_timeout_seconds,
        stdout_log_path=status.stdout_log_path,
        stderr_log_path=status.stderr_log_path,
    )


def _serialize_state_response(response: LLMStateResponse) -> dict[str, Any]:
    return {
        "schema_version": response.schema_version,
        "state": response.state,
        "profile_id": response.profile_id,
        "family": response.family,
        "configured": response.configured,
        "available": response.available,
        "loaded": response.loaded,
        "model_name": response.model_name,
        "endpoint": response.endpoint,
        "timeout_seconds": response.timeout_seconds,
        "last_error": response.last_error,
        "requests_processed": response.requests_processed,
        "average_latency_ms": response.average_latency_ms,
        "last_request_epoch": response.last_request_epoch,
        "vram_allocated_mb": response.vram_allocated_mb,
        "ram_allocated_mb": response.ram_allocated_mb,
        "process_managed": response.process_managed,
        "process_running": response.process_running,
        "process_healthy": response.process_healthy,
        "started_by_backend": response.started_by_backend,
        "owner_pid": response.owner_pid,
        "health_url": response.health_url,
        "startup_timeout_seconds": response.startup_timeout_seconds,
        "stdout_log_path": response.stdout_log_path,
        "stderr_log_path": response.stderr_log_path,
    }


def register_llm_routes(router: Any) -> None:
    from fastapi import HTTPException, status

    @router.get("/session/llm")
    def get_session_llm_state() -> dict[str, Any]:
        manager = get_text_generation_sidecar_manager()
        response = _serialize_state(manager.status())
        return _serialize_state_response(response)

    @router.post("/session/llm/control")
    def post_session_llm_control(payload: LLMControlRequest) -> dict[str, Any]:
        manager = get_text_generation_sidecar_manager()
        request = TextGenerationRequest(
            prompt=(payload.prompt.strip() if isinstance(payload.prompt, str) else "Reply with the single word READY."),
            locale=payload.locale,
            profile_id=payload.profile_id,
        )
        action = payload.action.strip().lower()

        warmup_result: dict[str, Any] | None = None
        if action == "start":
            manager.start(request)
        elif action == "stop":
            manager.stop()
        elif action == "restart":
            manager.restart(request)
        elif action == "warmup":
            contract = manager.warmup(request)
            warmup_result = {
                "profile_id": contract.profile_id,
                "status": contract.status,
                "text": contract.text,
                "locale": contract.locale,
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported LLM control action: {payload.action}",
            )

        response = _serialize_state(manager.status(request))
        result = {
            "schema_version": 1,
            "action": action,
            "llm": _serialize_state_response(response),
        }
        if warmup_result is not None:
            result["warmup"] = warmup_result
        return result