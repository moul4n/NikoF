"""Durable backend persistence for camera / audio-input / audio-output settings.

These UI settings used to live only in the front-end (in-memory worker state +
one page's localStorage), so they reset on a backend restart and were invisible
to a freshly-loaded surface. They are now persisted to disk under the session
data root and served to every surface on load. See attention_worker.py,
stt_worker.py, and audio_output_settings.py. (Stage background already had this
via stage_view.py.)
"""
from __future__ import annotations

import asyncio
import inspect
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.session_routes import register_session_transport_routes  # noqa: E402  (path bootstrap above)
from app.schemas.session import AudioOutputUpdateRequest  # noqa: E402
from app.services.attention_worker import (  # noqa: E402
    DEFAULT_ATTENTION_DEVICE_ID,
    AttentionWorker,
)
from app.services.audio_output_settings import AudioOutputSettingsState  # noqa: E402
from app.services.stt_worker import STTWorker  # noqa: E402


def _run(awaitable):
    return asyncio.run(awaitable)


class AttentionPersistenceTests(unittest.TestCase):
    def test_enabled_tracking_device_and_marker_restore_across_instances(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "session" / "attention-prefs.json"
            first = AttentionWorker(state_path=state_path)
            _run(first.set_enabled(True))
            _run(first.set_tracking(True))
            _run(first.set_selected_device_with_label("cam-2", "Studio Cam"))
            _run(first.set_show_tracking_debug_marker(True))

            # A fresh instance (simulating a restart) restores from disk.
            restored = AttentionWorker(state_path=state_path)
            status = restored.status()
            self.assertTrue(status.enabled)
            self.assertTrue(status.tracking)
            self.assertEqual("cam-2", status.selected_device_id)
            self.assertEqual("Studio Cam", status.selected_device_label)
            self.assertTrue(status.show_tracking_debug_marker)

    def test_tracking_not_restored_while_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "session" / "attention-prefs.json"
            state_path.parent.mkdir(parents=True, exist_ok=True)
            # A stale/hand-edited file that claims tracking-on while attention-off
            # must never resume the camera.
            state_path.write_text(
                '{"enabled": false, "tracking": true, "selected_device_id": "cam-9"}',
                encoding="utf-8",
            )
            restored = AttentionWorker(state_path=state_path)
            status = restored.status()
            self.assertFalse(status.enabled)
            self.assertFalse(status.tracking)
            self.assertEqual("cam-9", status.selected_device_id)

    def test_in_memory_worker_does_not_touch_disk(self) -> None:
        worker = AttentionWorker(state_path=None)
        # No state_path => nothing persisted, defaults intact.
        _run(worker.set_enabled(True))
        self.assertTrue(worker.status().enabled)
        self.assertEqual(DEFAULT_ATTENTION_DEVICE_ID, worker.status().selected_device_id)

    def test_observation_device_change_persists_last_used_device(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "session" / "attention-prefs.json"
            worker = AttentionWorker(state_path=state_path)
            _run(worker.set_enabled(True))
            _run(
                worker.record_observation(
                    device_id="cam-from-browser",
                    device_label="Browser Cam",
                    captured_at=1.0,
                    frame_width=320,
                    frame_height=240,
                    subject=None,
                )
            )
            restored = AttentionWorker(state_path=state_path)
            self.assertEqual("cam-from-browser", restored.status().selected_device_id)


class _RecordingSttManager:
    """Minimal FasterWhisper manager stand-in that remembers the selected device
    so STTWorker._refresh_state reflects it (mirrors the real sidecar contract)."""

    def __init__(self) -> None:
        self.is_healthy = True
        self.device: str | None = None
        self.set_device_calls: list[str | None] = []

    def set_device(self, device_id: str | None) -> None:
        self.device = device_id
        self.set_device_calls.append(device_id)

    def state(self) -> dict[str, object]:
        return {
            "status": "ready",
            "state": "ready",
            "listening": False,
            "selected_device_id": self.device,
            "selected_device_label": f"Mic {self.device}" if self.device else None,
            "compute_device": "cpu",
            "compute_type": "int8",
            "model_name": "faster-whisper-medium",
            "next_sequence": 2,
            "last_error": None,
        }


class _FakeSttMonitor:
    def tracker(self, subsystem: str):
        del subsystem
        return _FakeSttTracker()


class _FakeSttTracker:
    requests_processed = 0
    average_latency_ms = None

    def snapshot(self):
        return self

    def mark_loaded(self, *args, **kwargs) -> None:
        del args, kwargs

    def mark_unloaded(self) -> None:
        pass


def _build_stt_worker(state_path: Path, manager: _RecordingSttManager) -> STTWorker:
    with patch("app.services.stt_worker.get_resource_monitor", return_value=_FakeSttMonitor()), patch(
        "app.services.stt_worker.get_server_manager", return_value=manager
    ):
        return STTWorker(state_path=state_path)


class SttDevicePersistenceTests(unittest.TestCase):
    def test_selected_device_persists_and_reapplies_on_restart(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "session" / "stt-prefs.json"
            manager = _RecordingSttManager()
            worker = _build_stt_worker(state_path, manager)
            _run(worker.set_selected_device("mic-3"))
            self.assertEqual("mic-3", worker.status().selected_device_id)

            # A fresh worker + fresh (reset) sidecar simulating a restart: the
            # saved id is restored and re-applied to the sidecar.
            restarted_manager = _RecordingSttManager()
            restarted = _build_stt_worker(state_path, restarted_manager)
            self.assertEqual("mic-3", restarted._persisted_device_id)
            # Mirror start(): the sidecar comes up with no selection, so refresh
            # syncs _selected_device_id to None before the saved id is re-applied.
            _run(restarted._refresh_state())
            self.assertIsNone(restarted.status().selected_device_id)
            _run(restarted._reapply_persisted_device())
            self.assertEqual(["mic-3"], restarted_manager.set_device_calls)
            self.assertEqual("mic-3", restarted.status().selected_device_id)

    def test_in_memory_worker_does_not_persist(self) -> None:
        manager = _RecordingSttManager()
        with patch("app.services.stt_worker.get_resource_monitor", return_value=_FakeSttMonitor()), patch(
            "app.services.stt_worker.get_server_manager", return_value=manager
        ):
            worker = STTWorker(state_path=None)
        # No state_path => selection still works in-memory, but nothing is written.
        self.assertIsNone(worker._state_path)
        _run(worker.set_selected_device("mic-7"))
        self.assertEqual("mic-7", worker.status().selected_device_id)


class AudioOutputSettingsTests(unittest.TestCase):
    def test_defaults_to_system_default(self) -> None:
        state = AudioOutputSettingsState()
        self.assertIsNone(state.device_id)
        self.assertIsNone(state.device_label)

    def test_selection_persists_and_restores_across_instances(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "session" / "audio-output.json"
            first = AudioOutputSettingsState(state_path=state_path)
            first.set_device("speaker-2", "Living Room Speakers")
            restored = AudioOutputSettingsState(state_path=state_path)
            self.assertEqual("speaker-2", restored.device_id)
            self.assertEqual("Living Room Speakers", restored.device_label)

    def test_clearing_device_resets_to_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "session" / "audio-output.json"
            state = AudioOutputSettingsState(state_path=state_path)
            state.set_device("speaker-2", "Speakers")
            state.set_device(None)
            self.assertIsNone(state.device_id)
            self.assertIsNone(state.device_label)
            restored = AudioOutputSettingsState(state_path=state_path)
            self.assertIsNone(restored.device_id)


class _FakeRoute:
    def __init__(self, path: str, endpoint, methods: tuple[str, ...]) -> None:
        self.path = path
        self.endpoint = endpoint
        self.methods = methods


class _FakeAPIRouter:
    def __init__(self) -> None:
        self.routes: list[_FakeRoute] = []

    def get(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "GET")

    def put(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "PUT")

    def post(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "POST")

    def websocket(self, path: str, **kwargs):
        # register_session_transport_routes also wires a websocket route; we only
        # exercise the audio-output HTTP endpoints, so accept and ignore it.
        del kwargs
        return self._register(path, "WEBSOCKET")

    def _register(self, path: str, method: str):
        def decorator(endpoint):
            self.routes.append(_FakeRoute(path=path, endpoint=endpoint, methods=(method,)))
            return endpoint

        return decorator


def _get_route(router: _FakeAPIRouter, *, path: str, method: str) -> _FakeRoute:
    return next(route for route in router.routes if route.path == path and method in route.methods)


def _invoke(endpoint, **kwargs):
    result = endpoint(**kwargs)
    if inspect.isawaitable(result):
        return asyncio.run(result)
    return result


class AudioOutputRouteTests(unittest.TestCase):
    def _register_routes(self, router: _FakeAPIRouter) -> None:
        # The transport-route registration wires many endpoints; we only exercise
        # the audio-output pair, so pass a minimal services object. The audio-output
        # handlers don't touch `services`.
        register_session_transport_routes(
            router,
            services=object(),
            serialize_dataclass_payload=lambda payload: payload,
        )

    def test_get_then_put_round_trips_through_durable_store(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = AudioOutputSettingsState(state_path=Path(tmp) / "session" / "audio-output.json")
            with patch(
                "app.api.session_routes.get_audio_output_settings_state", return_value=state
            ):
                router = _FakeAPIRouter()
                self._register_routes(router)

                initial = _invoke(_get_route(router, path="/session/audio-output", method="GET").endpoint)
                self.assertIsNone(initial["device_id"])

                updated = _invoke(
                    _get_route(router, path="/session/audio-output", method="PUT").endpoint,
                    update=AudioOutputUpdateRequest(device_id="speaker-5", device_label="USB DAC"),
                )
                self.assertEqual("speaker-5", updated["device_id"])
                self.assertEqual("USB DAC", updated["device_label"])

                # The durable store reflects the PUT.
                self.assertEqual("speaker-5", state.device_id)


if __name__ == "__main__":
    unittest.main()
