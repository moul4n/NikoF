from __future__ import annotations

from collections import deque
import queue
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, PropertyMock, patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.settings import AppPaths
from app.providers import faster_whisper_runtime
from app.providers.faster_whisper_runtime import HotMicRuntime, SERVER_SAMPLE_RATE_HZ
from app.services.stt_server import load_server_config, FasterWhisperServerManager


def build_app_paths(root: Path) -> AppPaths:
    assets_root = root / "assets"
    local_data_root = root / "local"
    models_root = local_data_root / "models"
    return AppPaths(
        repo_root=root,
        assets_root=assets_root,
        character_assets_root=assets_root / "characters",
        local_data_root=local_data_root,
        models_root=models_root,
        llm_models_root=models_root / "llm",
        stt_models_root=models_root / "stt",
        tts_models_root=models_root / "tts",
        embeddings_root=models_root / "embeddings",
        providers_root=local_data_root / "providers",
        cache_root=local_data_root / "cache",
    )


class FasterWhisperServerRuntimeTests(unittest.TestCase):
    def test_server_not_configured_for_scaffolded_model_root_only(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            model_root = app_paths.stt_models_root / "faster-whisper-medium"
            model_root.mkdir(parents=True)
            (model_root / "runtime.json").write_text("{}\n", encoding="utf-8")
            (model_root / "install-plan.json").write_text("{}\n", encoding="utf-8")

            manager = FasterWhisperServerManager(load_server_config(app_paths))

        self.assertFalse(manager.server_configured)

    def test_server_configured_when_payload_and_server_script_exist(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            model_root = app_paths.stt_models_root / "faster-whisper-medium"
            provider_root = app_paths.providers_root / "stt" / "faster-whisper"
            model_root.mkdir(parents=True)
            provider_root.mkdir(parents=True)
            (model_root / "model.bin").write_text("payload\n", encoding="utf-8")
            (provider_root / "main.py").write_text("print('stub')\n", encoding="utf-8")

            manager = FasterWhisperServerManager(load_server_config(app_paths))
            self.assertTrue(manager.server_configured)

    def test_start_reclaims_existing_healthy_sidecar_before_launch(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            manager = FasterWhisperServerManager(load_server_config(app_paths))

            with patch.object(FasterWhisperServerManager, "is_running", new_callable=PropertyMock, return_value=False), \
                patch.object(FasterWhisperServerManager, "is_healthy", new_callable=PropertyMock, return_value=True), \
                patch.object(FasterWhisperServerManager, "server_configured", new_callable=PropertyMock, return_value=True), \
                patch.object(manager, "_reclaim_external_server", return_value=True) as reclaim_mock, \
                patch.object(manager, "_wait_for_healthy", return_value=True), \
                patch("app.services.stt_server.subprocess.Popen") as popen_mock:
                process = Mock()
                process.poll.return_value = None
                popen_mock.return_value = process

                self.assertTrue(manager.start(allow_gpu=False))

            reclaim_mock.assert_called_once_with()
            popen_mock.assert_called_once()

    def test_start_fails_when_existing_healthy_sidecar_cannot_be_reclaimed(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir))
            manager = FasterWhisperServerManager(load_server_config(app_paths))

            with patch.object(FasterWhisperServerManager, "is_running", new_callable=PropertyMock, return_value=False), \
                patch.object(FasterWhisperServerManager, "is_healthy", new_callable=PropertyMock, return_value=True), \
                patch.object(manager, "_reclaim_external_server", return_value=False), \
                patch("app.services.stt_server.subprocess.Popen") as popen_mock:
                self.assertFalse(manager.start(allow_gpu=False))

            popen_mock.assert_not_called()

    def test_kill_process_uses_tree_termination(self) -> None:
        manager = FasterWhisperServerManager()
        process = Mock()
        process.pid = 1234
        manager._process = process

        with patch("app.services.stt_server.terminate_process_tree") as terminate_mock:
            manager._kill_process()

        terminate_mock.assert_called_once_with(process)
        self.assertIsNone(manager._process)


class SttEngineResolutionTests(unittest.TestCase):
    def test_resolve_engine_defaults_to_faster_whisper(self) -> None:
        with patch.dict(faster_whisper_runtime.os.environ, {}, clear=True):
            self.assertEqual(faster_whisper_runtime._resolve_engine_name(), "faster-whisper")

    def test_resolve_engine_selects_parakeet(self) -> None:
        with patch.dict(faster_whisper_runtime.os.environ, {"NIKOF_STT_ENGINE": "Parakeet"}, clear=True):
            self.assertEqual(faster_whisper_runtime._resolve_engine_name(), "parakeet")

    def test_resolve_engine_unknown_falls_back(self) -> None:
        with patch.dict(faster_whisper_runtime.os.environ, {"NIKOF_STT_ENGINE": "vosk"}, clear=True):
            self.assertEqual(faster_whisper_runtime._resolve_engine_name(), "faster-whisper")

    def test_parakeet_model_root_sits_beside_whisper(self) -> None:
        whisper_root = Path("/models/stt/faster-whisper-medium")
        self.assertEqual(
            faster_whisper_runtime._parakeet_model_root(whisper_root),
            Path("/models/stt") / faster_whisper_runtime.PARAKEET_MODEL_DIRNAME,
        )


@unittest.skipIf(faster_whisper_runtime.np is None, "numpy is required for STT runtime buffer tests")
class HotMicTranscribeSegmentTests(unittest.TestCase):
    def _runtime(self, engine_name: str, model: object) -> HotMicRuntime:
        runtime = HotMicRuntime.__new__(HotMicRuntime)
        runtime._engine_name = engine_name
        runtime._locale = "en-US"
        runtime._model = model
        return runtime

    def test_parakeet_branch_returns_recognized_text_without_ranges(self) -> None:
        class _FakeParakeet:
            def recognize(self, audio: object) -> str:
                return "  hey niko  "

        runtime = self._runtime("parakeet", _FakeParakeet())
        audio = faster_whisper_runtime.np.ones(SERVER_SAMPLE_RATE_HZ, dtype=faster_whisper_runtime.np.float32)
        transcript, ranges, confidence = runtime._transcribe_segment(audio)
        self.assertEqual(transcript, "hey niko")
        self.assertEqual(ranges, [])
        self.assertIsNone(confidence)

    def test_whisper_branch_aggregates_segments_and_confidence(self) -> None:
        class _Seg:
            def __init__(self, text: str, start: float, end: float, logprob: float) -> None:
                self.text = text
                self.start = start
                self.end = end
                self.avg_logprob = logprob

        class _FakeWhisper:
            def transcribe(self, audio: object, **kwargs: object) -> tuple[list[object], None]:
                return [_Seg("Hello", 0.0, 0.5, -0.1), _Seg("there.", 0.5, 1.0, -0.2)], None

        runtime = self._runtime("faster-whisper", _FakeWhisper())
        audio = faster_whisper_runtime.np.ones(SERVER_SAMPLE_RATE_HZ, dtype=faster_whisper_runtime.np.float32)
        transcript, ranges, confidence = runtime._transcribe_segment(audio)
        self.assertEqual(transcript, "Hello there.")
        self.assertEqual(len(ranges), 2)
        self.assertEqual(ranges[0]["end_ms"], 500)
        self.assertIsNotNone(confidence)


@unittest.skipIf(faster_whisper_runtime.np is None, "numpy is required for STT runtime buffer tests")
class HotMicRuntimeTests(unittest.TestCase):
    def test_stop_listening_flushes_active_segment_for_processing(self) -> None:
        runtime = HotMicRuntime.__new__(HotMicRuntime)
        runtime._model_root = Path("faster-whisper-medium")
        runtime._locale = "en-US"
        runtime._engine_name = "faster-whisper"
        runtime._owner_pid = None
        runtime._model = object()
        runtime._compute_device = "cpu"
        runtime._compute_type = "int8"
        runtime._stream_lock = threading.Lock()
        runtime._audio_lock = threading.Lock()
        runtime._stream = None
        runtime._listening = True
        runtime._state = "listening"
        runtime._last_error = None
        runtime._selected_device_id = None
        runtime._selected_device_label = None
        runtime._latest_confirmed_text = None
        runtime._latest_confirmed_at = None
        runtime._total_confirmed = 0
        runtime._total_submitted = 0
        runtime._event_sequence = 0
        runtime._events = deque(maxlen=256)
        runtime._segment_queue = queue.Queue(maxsize=8)
        runtime._current_chunks = [
            faster_whisper_runtime.np.ones(SERVER_SAMPLE_RATE_HZ // 4, dtype=faster_whisper_runtime.np.float32),
            faster_whisper_runtime.np.ones(SERVER_SAMPLE_RATE_HZ // 4, dtype=faster_whisper_runtime.np.float32),
        ]
        runtime._pre_roll = deque(maxlen=3)
        runtime._speech_blocks = 0
        runtime._silence_blocks = 0
        runtime._speaking = True

        response = runtime.stop_listening()

        segment, duration_ms = runtime._segment_queue.get_nowait()
        self.assertEqual(500, duration_ms)
        self.assertEqual(SERVER_SAMPLE_RATE_HZ // 2, int(segment.shape[0]))
        self.assertEqual("processing", response["state"])
        self.assertFalse(response["listening"])

    def test_intermittent_push_to_talk_speech_starts_segment_before_release(self) -> None:
        runtime = HotMicRuntime.__new__(HotMicRuntime)
        runtime._model_root = Path("faster-whisper-medium")
        runtime._locale = "en-US"
        runtime._engine_name = "faster-whisper"
        runtime._owner_pid = None
        runtime._model = object()
        runtime._compute_device = "cpu"
        runtime._compute_type = "int8"
        runtime._stream_lock = threading.Lock()
        runtime._audio_lock = threading.Lock()
        runtime._stream = None
        runtime._listening = True
        runtime._state = "listening"
        runtime._last_error = None
        runtime._selected_device_id = None
        runtime._selected_device_label = None
        runtime._latest_confirmed_text = None
        runtime._latest_confirmed_at = None
        runtime._total_confirmed = 0
        runtime._total_submitted = 0
        runtime._event_sequence = 0
        runtime._events = deque(maxlen=256)
        runtime._segment_queue = queue.Queue(maxsize=8)
        runtime._current_chunks = []
        runtime._pre_roll = deque(maxlen=3)
        runtime._speech_blocks = 0
        runtime._silence_blocks = 0
        runtime._speaking = False
        runtime._noise_floor = faster_whisper_runtime.MIN_RMS_THRESHOLD / 2

        loud = faster_whisper_runtime.np.ones(SERVER_SAMPLE_RATE_HZ // 10, dtype=faster_whisper_runtime.np.float32)
        quiet = faster_whisper_runtime.np.zeros(SERVER_SAMPLE_RATE_HZ // 10, dtype=faster_whisper_runtime.np.float32)

        runtime._consume_chunk(loud)
        runtime._consume_chunk(quiet)
        runtime._consume_chunk(loud)
        runtime._consume_chunk(quiet)
        runtime._consume_chunk(loud)

        response = runtime.stop_listening()

        segment, duration_ms = runtime._segment_queue.get_nowait()
        self.assertGreaterEqual(duration_ms, 500)
        self.assertGreaterEqual(int(segment.shape[0]), SERVER_SAMPLE_RATE_HZ // 2)
        self.assertEqual("processing", response["state"])
        self.assertFalse(response["listening"])


if __name__ == "__main__":
    unittest.main()