from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
from typing import Any

from fastapi import Request
from fastapi.responses import StreamingResponse

from app.services.attention_worker import ATTENTION_STREAM, AttentionInputDevice, AttentionSubjectSnapshot, AttentionWorkerStatus, get_attention_worker


@dataclass(slots=True, frozen=True)
class AttentionSubjectResponse:
    normalized_x: float
    normalized_y: float
    face_width: float | None
    face_height: float | None


@dataclass(slots=True, frozen=True)
class AttentionStateResponse:
    schema_version: int
    state: str
    available: bool
    enabled: bool
    tracking: bool
    selected_device_id: str | None
    selected_device_label: str | None
    confidence: float | None
    subject: AttentionSubjectResponse | None
    last_observed_at: float | None
    last_error: str | None
    fps_target: int
    frame_width: int
    frame_height: int
    show_tracking_debug_marker: bool
    next_sequence: int


@dataclass(slots=True, frozen=True)
class AttentionDeviceSelectionRequest:
    device_id: str | None = None
    device_label: str | None = None


@dataclass(slots=True, frozen=True)
class AttentionEnabledRequest:
    enabled: bool


@dataclass(slots=True, frozen=True)
class AttentionTrackingRequest:
    enabled: bool


@dataclass(slots=True, frozen=True)
class AttentionDebugMarkerRequest:
    enabled: bool


@dataclass(slots=True, frozen=True)
class AttentionObservationRequest:
    schema_version: int = 1
    device_id: str | None = None
    device_label: str | None = None
    captured_at: float | None = None
    frame_width: int | None = None
    frame_height: int | None = None
    subject: dict[str, Any] | None = None


def _serialize_subject(subject: AttentionSubjectSnapshot | None) -> dict[str, Any] | None:
    if subject is None:
        return None
    return {
        "normalized_x": subject.normalized_x,
        "normalized_y": subject.normalized_y,
        "face_width": subject.face_width,
        "face_height": subject.face_height,
    }


def _serialize_status(status: AttentionWorkerStatus) -> AttentionStateResponse:
    return AttentionStateResponse(
        schema_version=1,
        state=status.state.value if hasattr(status.state, "value") else str(status.state),
        available=status.available,
        enabled=status.enabled,
        tracking=status.tracking,
        selected_device_id=status.selected_device_id,
        selected_device_label=status.selected_device_label,
        confidence=status.confidence,
        subject=(AttentionSubjectResponse(**_serialize_subject(status.subject)) if status.subject is not None else None),
        last_observed_at=status.last_observed_at,
        last_error=status.last_error,
        fps_target=status.fps_target,
        frame_width=status.frame_width,
        frame_height=status.frame_height,
        show_tracking_debug_marker=status.show_tracking_debug_marker,
        next_sequence=status.next_sequence,
    )


def _serialize_device(device: AttentionInputDevice) -> dict[str, Any]:
    return {
        "device_id": device.device_id,
        "label": device.label,
        "default": device.default,
    }


def _serialize_state_response(response: AttentionStateResponse) -> dict[str, Any]:
    return {
        "schema_version": response.schema_version,
        "state": response.state,
        "available": response.available,
        "enabled": response.enabled,
        "tracking": response.tracking,
        "selected_device_id": response.selected_device_id,
        "selected_device_label": response.selected_device_label,
        "confidence": response.confidence,
        "subject": None if response.subject is None else {
            "normalized_x": response.subject.normalized_x,
            "normalized_y": response.subject.normalized_y,
            "face_width": response.subject.face_width,
            "face_height": response.subject.face_height,
        },
        "last_observed_at": response.last_observed_at,
        "last_error": response.last_error,
        "fps_target": response.fps_target,
        "frame_width": response.frame_width,
        "frame_height": response.frame_height,
        "show_tracking_debug_marker": response.show_tracking_debug_marker,
        "next_sequence": response.next_sequence,
    }


def _build_sse_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }


def _build_sse_frame(*, event_name: str, payload: dict[str, Any], cursor: str | None = None) -> str:
    body = json.dumps(payload, separators=(",", ":"))
    frame_lines = [f"event: {event_name}"]
    if cursor is not None:
        frame_lines.append(f"id: {cursor}")
    frame_lines.append(f"data: {body}")
    return "\n".join(frame_lines) + "\n\n"


def register_attention_routes(router: Any) -> None:
    @router.get("/session/attention")
    async def get_session_attention_state() -> dict[str, Any]:
        response = _serialize_status(get_attention_worker().status())
        return _serialize_state_response(response)

    @router.get("/session/attention/live")
    async def get_session_attention_live(request: Request) -> Any:
        worker = get_attention_worker()
        current_status = worker.status()
        current_payload = _serialize_state_response(_serialize_status(current_status))

        async def stream_updates():
            initial_cursor = f"{ATTENTION_STREAM}:{max(0, current_status.next_sequence - 1)}"
            yield _build_sse_frame(
                event_name=ATTENTION_STREAM,
                payload=current_payload,
                cursor=initial_cursor,
            )

            async for update in _iterate_live_statuses(worker):
                if await request.is_disconnected():
                    break

                sequence = max(0, update.next_sequence - 1)
                yield _build_sse_frame(
                    event_name=ATTENTION_STREAM,
                    payload=_serialize_state_response(_serialize_status(update)),
                    cursor=f"{ATTENTION_STREAM}:{sequence}",
                )

        return StreamingResponse(
            stream_updates(),
            media_type="text/event-stream",
            headers=_build_sse_headers(),
        )

    @router.get("/session/attention/devices")
    async def get_session_attention_devices() -> dict[str, Any]:
        devices = await get_attention_worker().list_devices()
        return {
            "schema_version": 1,
            "devices": [_serialize_device(device) for device in devices],
        }

    @router.put("/session/attention/device")
    async def put_session_attention_device(selection: AttentionDeviceSelectionRequest) -> dict[str, Any]:
        response = _serialize_status(
            await get_attention_worker().set_selected_device_with_label(selection.device_id, selection.device_label)
        )
        return _serialize_state_response(response)

    @router.put("/session/attention/enabled")
    async def put_session_attention_enabled(update: AttentionEnabledRequest) -> dict[str, Any]:
        response = _serialize_status(await get_attention_worker().set_enabled(update.enabled))
        return _serialize_state_response(response)

    @router.put("/session/attention/tracking")
    async def put_session_attention_tracking(update: AttentionTrackingRequest) -> dict[str, Any]:
        response = _serialize_status(await get_attention_worker().set_tracking(update.enabled))
        return _serialize_state_response(response)

    @router.put("/session/attention/debug-marker")
    async def put_session_attention_debug_marker(update: AttentionDebugMarkerRequest) -> dict[str, Any]:
        response = _serialize_status(await get_attention_worker().set_show_tracking_debug_marker(update.enabled))
        return _serialize_state_response(response)

    @router.post("/session/attention/observations")
    async def post_session_attention_observations(payload: AttentionObservationRequest) -> dict[str, Any]:
        response = _serialize_status(
            await get_attention_worker().record_observation(
                device_id=payload.device_id,
                device_label=payload.device_label,
                captured_at=payload.captured_at,
                frame_width=payload.frame_width,
                frame_height=payload.frame_height,
                subject=payload.subject,
            )
        )
        return _serialize_state_response(response)


async def _iterate_live_statuses(worker: Any):
    iterator = worker.iter_live_statuses(after_sequence=max(0, worker.status().next_sequence - 1))
    while True:
        item = await asyncio.to_thread(next, iterator, _STREAM_ITERATION_COMPLETE)
        if item is _STREAM_ITERATION_COMPLETE:
            break
        yield item


_STREAM_ITERATION_COMPLETE = object()