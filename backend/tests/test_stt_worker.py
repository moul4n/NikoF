from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.stt_worker import STTWorker, _should_submit_transcript


class _FakeTracker:
    def __init__(self) -> None:
        self.requests_processed = 0
        self.average_latency_ms = None

    def snapshot(self):
        return self

    def mark_loaded(self, model_name: str, vram_mb: float | None = None, ram_mb: float | None = None) -> None:
        del model_name, vram_mb, ram_mb

    def record_request(self, latency_ms: float) -> None:
        self.requests_processed += 1
        self.average_latency_ms = latency_ms

    def mark_unloaded(self) -> None:
        self.requests_processed = 0
        self.average_latency_ms = None


class _FakeMonitor:
    def __init__(self) -> None:
        self._tracker = _FakeTracker()

    def tracker(self, subsystem: str):
        del subsystem
        return self._tracker


class _FakeManager:
    def __init__(self) -> None:
        self.is_healthy = True

    def events(self, *, after_sequence: int) -> dict[str, object]:
        del after_sequence
        return {
            "events": [
                {
                    "sequence": 1,
                    "event_type": "transcript.confirmed",
                    "state": "processing",
                    "transcript": "hello",
                    "locale": "en-US",
                    "confidence": 0.91,
                    "duration_ms": 640,
                    "latency_ms": 212.0,
                    "timestamp_epoch": 1234.5,
                }
            ],
            "next_sequence": 2,
        }

    def state(self) -> dict[str, object]:
        return {
            "status": "ready",
            "state": "ready",
            "listening": False,
            "selected_device_id": "3",
            "selected_device_label": "Chat Mic",
            "compute_device": "cpu",
            "compute_type": "int8",
            "model_name": "faster-whisper-medium",
            "next_sequence": 2,
            "last_error": None,
        }


class STTWorkerDispatchTests(unittest.IsolatedAsyncioTestCase):
    def test_submission_filter_accepts_short_non_filler_transcripts(self) -> None:
        self.assertTrue(_should_submit_transcript("hello"))
        self.assertFalse(_should_submit_transcript("okay"))

    async def test_confirmed_transcript_is_forwarded_through_user_turn_pipeline(self) -> None:
        fake_monitor = _FakeMonitor()
        fake_manager = _FakeManager()

        with patch("app.services.stt_worker.get_resource_monitor", return_value=fake_monitor), patch(
            "app.services.stt_worker.get_server_manager", return_value=fake_manager
        ), patch("app.services.stt_worker.run_user_text_turn") as run_turn_mock:
            worker = STTWorker()
            worker.configure_turn_services(object())

            await worker._process_events()

        run_turn_mock.assert_called_once()
        request = run_turn_mock.call_args.args[0]
        self.assertEqual("hello", request.text)
        self.assertEqual("session.stt.accepted", request.session_event_type)
        self.assertTrue(request.defer_synthesis)
        self.assertIsNotNone(request.transcription)
        self.assertEqual("hello", request.transcription.transcript)

        status = worker.status()
        self.assertEqual("hello", status.latest_confirmed_text)
        self.assertEqual(1, status.total_submitted)
        self.assertEqual("submitted", status.transcript_chunks[0].dispatch_state)
        self.assertEqual("llm", status.transcript_chunks[0].dispatch_target)

    async def test_submit_transcript_uses_dedicated_dispatch_executor(self) -> None:
        fake_monitor = _FakeMonitor()
        fake_manager = _FakeManager()

        class _CapturingLoop:
            def __init__(self) -> None:
                self.executor = None

            async def run_in_executor(self, executor, func):
                self.executor = executor
                return func()

        loop = _CapturingLoop()

        with patch("app.services.stt_worker.get_resource_monitor", return_value=fake_monitor), patch(
            "app.services.stt_worker.get_server_manager", return_value=fake_manager
        ), patch("app.services.stt_worker.asyncio.get_running_loop", return_value=loop), patch(
            "app.services.stt_worker.run_user_text_turn"
        ):
            worker = STTWorker()
            worker.configure_turn_services(object())
            chunk = worker._record_transcript_chunk(
                transcript="hello",
                locale="en-US",
                confidence=0.91,
                duration_ms=640,
                processing_ms=212.0,
                accepted_for_dispatch=True,
                dispatch_state="queued",
                dispatch_target="llm",
                dispatch_detail="Queued for dispatch.",
            )

            await worker._submit_transcript(
                chunk_id=chunk.chunk_id,
                transcript="hello",
                locale="en-US",
                confidence=0.91,
                duration_ms=640,
            )

        self.assertIs(loop.executor, worker._dispatch_executor)
        self.assertEqual("submitted", worker.status().transcript_chunks[0].dispatch_state)


if __name__ == "__main__":
    unittest.main()