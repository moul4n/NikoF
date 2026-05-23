from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any

from app.core.settings import AppPaths, get_app_paths


DEFAULT_ATTENTION_DEVICE_ID = "camera-default"
DEFAULT_ATTENTION_DEVICE_LABEL = "Browser default camera"
DEFAULT_ATTENTION_FPS_TARGET = 8
DEFAULT_ATTENTION_FRAME_WIDTH = 320
DEFAULT_ATTENTION_FRAME_HEIGHT = 240
DEFAULT_STALE_AFTER_SECONDS = 1.0
DEFAULT_TRACKING_CONFIDENCE = 0.45
ATTENTION_STREAM = "session.attention"


class AttentionWorkerState(str, Enum):
    DISABLED = "disabled"
    IDLE = "idle"
    TRACKING = "tracking"
    DEGRADED = "degraded"
    SHUTDOWN = "shutdown"


@dataclass(slots=True, frozen=True)
class AttentionInputDevice:
    device_id: str
    label: str
    default: bool


@dataclass(slots=True, frozen=True)
class AttentionSubjectSnapshot:
    normalized_x: float
    normalized_y: float
    face_width: float | None
    face_height: float | None


@dataclass(slots=True, frozen=True)
class AttentionWorkerStatus:
    state: AttentionWorkerState
    available: bool
    enabled: bool
    tracking: bool
    selected_device_id: str | None
    selected_device_label: str | None
    confidence: float | None
    subject: AttentionSubjectSnapshot | None
    last_observed_at: float | None
    last_error: str | None
    fps_target: int
    frame_width: int
    frame_height: int
    next_sequence: int


class AttentionWorker:
    def __init__(self, *, app_paths: AppPaths | None = None) -> None:
        self._app_paths = app_paths or get_app_paths()
        self._state = AttentionWorkerState.DISABLED
        self._available = False
        self._enabled = False
        self._tracking_requested = False
        self._selected_device_id = DEFAULT_ATTENTION_DEVICE_ID
        self._selected_device_label = DEFAULT_ATTENTION_DEVICE_LABEL
        self._confidence: float | None = None
        self._subject: AttentionSubjectSnapshot | None = None
        self._last_observed_at: float | None = None
        self._last_error: str | None = None
        self._fps_target = DEFAULT_ATTENTION_FPS_TARGET
        self._frame_width = DEFAULT_ATTENTION_FRAME_WIDTH
        self._frame_height = DEFAULT_ATTENTION_FRAME_HEIGHT
        self._next_sequence = 1
        self._lock = threading.Lock()

    async def start(self) -> None:
        with self._lock:
            self._available = True
            self._refresh_state_locked()

    async def stop(self) -> None:
        with self._lock:
            self._available = False
            self._state = AttentionWorkerState.SHUTDOWN

    def status(self) -> AttentionWorkerStatus:
        with self._lock:
            self._refresh_state_locked()
            return AttentionWorkerStatus(
                state=self._state,
                available=self._available,
                enabled=self._enabled,
                tracking=self._tracking_requested,
                selected_device_id=self._selected_device_id,
                selected_device_label=self._selected_device_label,
                confidence=self._confidence,
                subject=self._subject,
                last_observed_at=self._last_observed_at,
                last_error=self._last_error,
                fps_target=self._fps_target,
                frame_width=self._frame_width,
                frame_height=self._frame_height,
                next_sequence=self._next_sequence,
            )

    async def list_devices(self) -> tuple[AttentionInputDevice, ...]:
        return (
            AttentionInputDevice(
                device_id=DEFAULT_ATTENTION_DEVICE_ID,
                label=DEFAULT_ATTENTION_DEVICE_LABEL,
                default=True,
            ),
        )

    async def set_selected_device(self, device_id: str | None) -> AttentionWorkerStatus:
        return await self.set_selected_device_with_label(device_id, None)

    async def set_selected_device_with_label(self, device_id: str | None, device_label: str | None) -> AttentionWorkerStatus:
        with self._lock:
            self._selected_device_id = device_id or DEFAULT_ATTENTION_DEVICE_ID
            self._selected_device_label = device_label or DEFAULT_ATTENTION_DEVICE_LABEL
            self._bump_sequence_locked()
            self._refresh_state_locked()
        return self.status()

    async def set_enabled(self, enabled: bool) -> AttentionWorkerStatus:
        with self._lock:
            self._enabled = enabled
            if not enabled:
                self._tracking_requested = False
                self._confidence = None
                self._subject = None
                self._last_observed_at = None
                self._last_error = None
            self._bump_sequence_locked()
            self._refresh_state_locked()
        return self.status()

    async def set_tracking(self, enabled: bool) -> AttentionWorkerStatus:
        with self._lock:
            self._tracking_requested = enabled and self._enabled
            if not self._tracking_requested:
                self._confidence = None
                self._subject = None
                self._last_observed_at = None
            self._bump_sequence_locked()
            self._refresh_state_locked()
        return self.status()

    async def record_observation(
        self,
        *,
        device_id: str | None,
        device_label: str | None,
        captured_at: float | None,
        frame_width: int | None,
        frame_height: int | None,
        subject: dict[str, Any] | None,
    ) -> AttentionWorkerStatus:
        with self._lock:
            if device_id:
                self._selected_device_id = device_id
            if device_label:
                self._selected_device_label = device_label
            if frame_width and frame_width > 0:
                self._frame_width = frame_width
            if frame_height and frame_height > 0:
                self._frame_height = frame_height

            if not self._enabled or not self._tracking_requested:
                self._refresh_state_locked()
                return self.status()

            tracked = bool(subject.get("tracked")) if isinstance(subject, dict) else False
            confidence = _coerce_optional_float(subject.get("confidence")) if isinstance(subject, dict) else None
            normalized_x = _coerce_optional_float(subject.get("normalized_x")) if isinstance(subject, dict) else None
            normalized_y = _coerce_optional_float(subject.get("normalized_y")) if isinstance(subject, dict) else None
            face_width = _coerce_optional_float(subject.get("face_width")) if isinstance(subject, dict) else None
            face_height = _coerce_optional_float(subject.get("face_height")) if isinstance(subject, dict) else None

            if tracked and normalized_x is not None and normalized_y is not None and (confidence or 0.0) >= DEFAULT_TRACKING_CONFIDENCE:
                self._subject = AttentionSubjectSnapshot(
                    normalized_x=max(0.0, min(1.0, normalized_x)),
                    normalized_y=max(0.0, min(1.0, normalized_y)),
                    face_width=face_width,
                    face_height=face_height,
                )
                self._confidence = confidence
                self._last_observed_at = captured_at or time.time()
                self._last_error = None
            else:
                self._subject = None
                self._confidence = confidence
                self._last_observed_at = captured_at or time.time()

            self._bump_sequence_locked()
            self._refresh_state_locked()
        return self.status()

    def _refresh_state_locked(self) -> None:
        if not self._available:
            self._state = AttentionWorkerState.SHUTDOWN
            return

        if not self._enabled:
            self._state = AttentionWorkerState.DISABLED
            return

        if not self._tracking_requested:
            self._state = AttentionWorkerState.IDLE
            return

        if self._last_observed_at is None:
            self._state = AttentionWorkerState.IDLE
            return

        if time.time() - self._last_observed_at > DEFAULT_STALE_AFTER_SECONDS:
            self._subject = None
            self._confidence = None
            self._state = AttentionWorkerState.IDLE
            return

        if self._subject is not None and (self._confidence or 0.0) >= DEFAULT_TRACKING_CONFIDENCE:
            self._state = AttentionWorkerState.TRACKING
            return

        self._state = AttentionWorkerState.DEGRADED

    def _bump_sequence_locked(self) -> None:
        self._next_sequence += 1

    def iter_live_statuses(
        self,
        *,
        after_sequence: int | None = None,
        poll_interval_seconds: float = 0.25,
    ):
        observed_sequence = max(0, after_sequence or 0)

        while True:
            status = self.status()
            current_sequence = max(0, status.next_sequence - 1)
            if current_sequence > observed_sequence:
                observed_sequence = current_sequence
                yield status
                continue

            time.sleep(max(0.05, poll_interval_seconds))


def _coerce_optional_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


_attention_worker: AttentionWorker | None = None
_attention_worker_lock = threading.Lock()


def get_attention_worker(app_paths: AppPaths | None = None) -> AttentionWorker:
    global _attention_worker
    resolved_paths = app_paths or get_app_paths()
    if _attention_worker is None:
        with _attention_worker_lock:
            if _attention_worker is None:
                _attention_worker = AttentionWorker(app_paths=resolved_paths)
    return _attention_worker