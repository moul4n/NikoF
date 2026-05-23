"""Resource monitoring and worker status API routes."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from app.services.llm import TextGenerationSidecarManager, TextGenerationSidecarStatus, get_text_generation_sidecar_manager
from app.services.resource_monitor import get_resource_monitor, ResourceSnapshot
from app.services.stt_worker import STTWorkerStatus, get_stt_worker
from app.services.tts_worker import get_tts_worker, TTSWorkerStatus


@dataclass(slots=True, frozen=True)
class ResourceStatusResponse:
    schema_version: int
    timestamp_epoch: float
    gpu: dict[str, Any] | None
    gpu_processes: list[dict[str, Any]]
    owned_processes: list[dict[str, Any]]
    system_memory: dict[str, Any]
    subsystems: list[dict[str, Any]]
    llm_sidecar: dict[str, Any]
    tts_worker: dict[str, Any]
    stt_worker: dict[str, Any]
    warnings: list[str]


def _serialize_gpu(snap: ResourceSnapshot) -> dict[str, Any] | None:
    if snap.gpu is None:
        return None
    return {
        "device_index": snap.gpu.device_index,
        "device_name": snap.gpu.device_name,
        "vram_total_mb": round(snap.gpu.vram_total_mb, 1),
        "vram_used_mb": round(snap.gpu.vram_used_mb, 1),
        "vram_free_mb": round(snap.gpu.vram_free_mb, 1),
        "utilization_percent": snap.gpu.utilization_percent,
    }


def _serialize_system_memory(snap: ResourceSnapshot) -> dict[str, Any]:
    return {
        "ram_total_mb": round(snap.system_memory.ram_total_mb, 1),
        "ram_used_mb": round(snap.system_memory.ram_used_mb, 1),
        "ram_available_mb": round(snap.system_memory.ram_available_mb, 1),
        "ram_percent": round(snap.system_memory.ram_percent, 1),
    }


def _serialize_gpu_processes(snap: ResourceSnapshot) -> list[dict[str, Any]]:
    return [
        {
            "pid": process.pid,
            "process_name": process.process_name,
            "used_memory_mb": round(process.used_memory_mb, 1) if process.used_memory_mb is not None else None,
            "gpu_uuid": process.gpu_uuid,
        }
        for process in snap.gpu_processes
    ]


def _serialize_owned_processes(snap: ResourceSnapshot) -> list[dict[str, Any]]:
    return [
        {
            "pid": process.pid,
            "parent_pid": process.parent_pid,
            "label": process.label,
            "process_name": process.process_name,
            "executable": process.executable,
            "command": process.command,
            "status": process.status,
            "rss_mb": round(process.rss_mb, 1) if process.rss_mb is not None else None,
            "gpu_memory_mb": round(process.gpu_memory_mb, 1) if process.gpu_memory_mb is not None else None,
        }
        for process in snap.owned_processes
    ]


def _serialize_subsystems(snap: ResourceSnapshot) -> list[dict[str, Any]]:
    return [
        {
            "subsystem": s.subsystem,
            "loaded": s.loaded,
            "model_name": s.model_name,
            "vram_allocated_mb": round(s.vram_allocated_mb, 1) if s.vram_allocated_mb else None,
            "ram_allocated_mb": round(s.ram_allocated_mb, 1) if s.ram_allocated_mb else None,
            "last_request_epoch": s.last_request_epoch,
            "requests_processed": s.requests_processed,
            "average_latency_ms": round(s.average_latency_ms, 1) if s.average_latency_ms else None,
        }
        for s in snap.subsystems
    ]


def _serialize_llm_sidecar(status: TextGenerationSidecarStatus) -> dict[str, Any]:
    return {
        "state": status.state.value if hasattr(status.state, "value") else str(status.state),
        "profile_id": status.profile_id,
        "family": status.family,
        "configured": status.configured,
        "available": status.available,
        "loaded": status.loaded,
        "model_name": status.model_name,
        "endpoint": status.endpoint,
        "timeout_seconds": status.timeout_seconds,
        "last_error": status.last_error,
        "requests_processed": status.requests_processed,
        "average_latency_ms": round(status.average_latency_ms, 1) if status.average_latency_ms else None,
        "last_request_epoch": status.last_request_epoch,
        "vram_allocated_mb": round(status.vram_allocated_mb, 1) if status.vram_allocated_mb else None,
        "ram_allocated_mb": round(status.ram_allocated_mb, 1) if status.ram_allocated_mb else None,
        "process_managed": status.process_managed,
        "process_running": status.process_running,
        "process_healthy": status.process_healthy,
        "started_by_backend": status.started_by_backend,
        "owner_pid": status.owner_pid,
        "health_url": status.health_url,
        "startup_timeout_seconds": status.startup_timeout_seconds,
        "stdout_log_path": status.stdout_log_path,
        "stderr_log_path": status.stderr_log_path,
    }


def _serialize_tts_worker(status: TTSWorkerStatus) -> dict[str, Any]:
    return {
        "state": status.state.value if hasattr(status.state, "value") else str(status.state),
        "model_name": status.model_name,
        "queue_depth": status.queue_depth,
        "max_queue_depth": status.max_queue_depth,
        "total_processed": status.total_processed,
        "average_latency_ms": round(status.average_latency_ms, 1) if status.average_latency_ms else None,
        "last_error": status.last_error,
        "vram_allocated_mb": round(status.vram_allocated_mb, 1) if status.vram_allocated_mb else None,
    }


def _serialize_stt_worker(status: STTWorkerStatus) -> dict[str, Any]:
    return {
        "state": status.state.value if hasattr(status.state, "value") else str(status.state),
        "model_name": status.model_name,
        "available": status.available,
        "listening": status.listening,
        "selected_device_id": status.selected_device_id,
        "selected_device_label": status.selected_device_label,
        "latest_confirmed_text": status.latest_confirmed_text,
        "latest_confirmed_at": status.latest_confirmed_at,
        "total_processed": status.total_processed,
        "total_submitted": status.total_submitted,
        "average_latency_ms": round(status.average_latency_ms, 1) if status.average_latency_ms else None,
        "last_error": status.last_error,
        "compute_device": status.compute_device,
        "compute_type": status.compute_type,
        "next_sequence": status.next_sequence,
    }


def build_resource_status_response(
    llm_sidecar_manager: TextGenerationSidecarManager | None = None,
) -> ResourceStatusResponse:
    monitor = get_resource_monitor()
    snap = monitor.snapshot()
    llm_manager = llm_sidecar_manager or get_text_generation_sidecar_manager()
    tts_worker = get_tts_worker()
    stt_worker = get_stt_worker()

    return ResourceStatusResponse(
        schema_version=1,
        timestamp_epoch=snap.timestamp_epoch,
        gpu=_serialize_gpu(snap),
        gpu_processes=_serialize_gpu_processes(snap),
        owned_processes=_serialize_owned_processes(snap),
        system_memory=_serialize_system_memory(snap),
        subsystems=_serialize_subsystems(snap),
        llm_sidecar=_serialize_llm_sidecar(llm_manager.status()),
        tts_worker=_serialize_tts_worker(tts_worker.status()),
        stt_worker=_serialize_stt_worker(stt_worker.status()),
        warnings=list(snap.warnings),
    )


def register_resource_routes(router: Any) -> None:
    """Register resource monitoring endpoints on the FastAPI router."""

    @router.get("/system/resources")
    def get_system_resources() -> dict[str, Any]:
        response = build_resource_status_response()
        return {
            "schema_version": response.schema_version,
            "timestamp_epoch": response.timestamp_epoch,
            "gpu": response.gpu,
            "gpu_processes": response.gpu_processes,
            "owned_processes": response.owned_processes,
            "system_memory": response.system_memory,
            "subsystems": response.subsystems,
            "llm_sidecar": response.llm_sidecar,
            "tts_worker": response.tts_worker,
            "stt_worker": response.stt_worker,
            "warnings": response.warnings,
        }
