from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.stt_worker import STTInputDevice, STTTranscriptChunk, STTWorkerStatus, get_stt_worker


@dataclass(slots=True, frozen=True)
class STTStateResponse:
    schema_version: int
    state: str
    available: bool
    listening: bool
    model_name: str | None
    selected_device_id: str | None
    selected_device_label: str | None
    latest_confirmed_text: str | None
    latest_confirmed_at: float | None
    total_processed: int
    total_submitted: int
    average_latency_ms: float | None
    last_error: str | None
    compute_device: str | None
    compute_type: str | None
    next_sequence: int
    transcript_chunks: tuple[dict[str, Any], ...]


@dataclass(slots=True, frozen=True)
class STTDeviceSelectionRequest:
    device_id: str | None = None


@dataclass(slots=True, frozen=True)
class STTListeningRequest:
    enabled: bool


@dataclass(slots=True, frozen=True)
class STTControlRequest:
    action: str


def _serialize_status(status: STTWorkerStatus) -> STTStateResponse:
    return STTStateResponse(
        schema_version=1,
        state=status.state.value if hasattr(status.state, "value") else str(status.state),
        available=status.available,
        listening=status.listening,
        model_name=status.model_name,
        selected_device_id=status.selected_device_id,
        selected_device_label=status.selected_device_label,
        latest_confirmed_text=status.latest_confirmed_text,
        latest_confirmed_at=status.latest_confirmed_at,
        total_processed=status.total_processed,
        total_submitted=status.total_submitted,
        average_latency_ms=status.average_latency_ms,
        last_error=status.last_error,
        compute_device=status.compute_device,
        compute_type=status.compute_type,
        next_sequence=status.next_sequence,
        transcript_chunks=tuple(_serialize_chunk(chunk) for chunk in status.transcript_chunks),
    )


def _serialize_device(device: STTInputDevice) -> dict[str, Any]:
    return {
        "device_id": device.device_id,
        "label": device.label,
        "default": device.default,
        "sample_rate_hz": device.sample_rate_hz,
        "max_input_channels": device.max_input_channels,
    }


def _serialize_chunk(chunk: STTTranscriptChunk) -> dict[str, Any]:
    return {
        "chunk_id": chunk.chunk_id,
        "transcript": chunk.transcript,
        "locale": chunk.locale,
        "captured_at": chunk.captured_at,
        "duration_ms": chunk.duration_ms,
        "processing_ms": chunk.processing_ms,
        "confidence": chunk.confidence,
        "accepted_for_dispatch": chunk.accepted_for_dispatch,
        "dispatch_state": chunk.dispatch_state,
        "dispatch_target": chunk.dispatch_target,
        "dispatch_detail": chunk.dispatch_detail,
    }


def _serialize_state_response(response: STTStateResponse) -> dict[str, Any]:
    return {
        "schema_version": response.schema_version,
        "state": response.state,
        "available": response.available,
        "listening": response.listening,
        "model_name": response.model_name,
        "selected_device_id": response.selected_device_id,
        "selected_device_label": response.selected_device_label,
        "latest_confirmed_text": response.latest_confirmed_text,
        "latest_confirmed_at": response.latest_confirmed_at,
        "total_processed": response.total_processed,
        "total_submitted": response.total_submitted,
        "average_latency_ms": response.average_latency_ms,
        "last_error": response.last_error,
        "compute_device": response.compute_device,
        "compute_type": response.compute_type,
        "next_sequence": response.next_sequence,
        "transcript_chunks": list(response.transcript_chunks),
    }


def register_stt_routes(router: Any) -> None:
    from fastapi import HTTPException, status

    @router.get("/session/stt")
    async def get_session_stt_state() -> dict[str, Any]:
        response = _serialize_status(get_stt_worker().status())
        return _serialize_state_response(response)

    @router.get("/session/stt/devices")
    async def get_session_stt_devices() -> dict[str, Any]:
        devices = await get_stt_worker().list_devices()
        return {
            "schema_version": 1,
            "devices": [_serialize_device(device) for device in devices],
        }

    @router.put("/session/stt/device")
    async def put_session_stt_device(selection: STTDeviceSelectionRequest) -> dict[str, Any]:
        response = _serialize_status(await get_stt_worker().set_selected_device(selection.device_id))
        return _serialize_state_response(response)

    @router.put("/session/stt/listening")
    async def put_session_stt_listening(update: STTListeningRequest) -> dict[str, Any]:
        response = _serialize_status(await get_stt_worker().set_listening(update.enabled))
        return _serialize_state_response(response)

    @router.post("/session/stt/control")
    async def post_session_stt_control(payload: STTControlRequest) -> dict[str, Any]:
        worker = get_stt_worker()
        action = payload.action.strip().lower()

        if action == "start":
            await worker.start()
        elif action == "stop":
            await worker.stop()
        elif action == "restart":
            await worker.stop()
            await worker.start()
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported STT control action: {payload.action}",
            )

        response = _serialize_status(worker.status())
        result = _serialize_state_response(response)
        result["action"] = action
        return result