"""Resource monitoring and TTS worker status API routes."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from app.services.resource_monitor import get_resource_monitor, ResourceSnapshot
from app.services.tts_worker import get_tts_worker, TTSWorkerStatus


@dataclass(slots=True, frozen=True)
class ResourceStatusResponse:
    schema_version: int
    timestamp_epoch: float
    gpu: dict[str, Any] | None
    system_memory: dict[str, Any]
    subsystems: list[dict[str, Any]]
    tts_worker: dict[str, Any]
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


def build_resource_status_response() -> ResourceStatusResponse:
    monitor = get_resource_monitor()
    snap = monitor.snapshot()
    tts_worker = get_tts_worker()

    return ResourceStatusResponse(
        schema_version=1,
        timestamp_epoch=snap.timestamp_epoch,
        gpu=_serialize_gpu(snap),
        system_memory=_serialize_system_memory(snap),
        subsystems=_serialize_subsystems(snap),
        tts_worker=_serialize_tts_worker(tts_worker.status()),
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
            "system_memory": response.system_memory,
            "subsystems": response.subsystems,
            "tts_worker": response.tts_worker,
            "warnings": response.warnings,
        }
