from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.speech_audio_broadcast import (
    SpeechAudioBroadcaster,
    get_speech_audio_broadcaster,
)


class SpeechAudioBroadcasterTests(unittest.TestCase):
    def test_publish_from_thread_reaches_subscriber(self) -> None:
        async def scenario() -> tuple[dict, bytes]:
            broadcaster = SpeechAudioBroadcaster()
            broadcaster.bind_loop(asyncio.get_running_loop())
            queue = broadcaster.subscribe("session-a")
            self.assertTrue(broadcaster.has_subscribers)

            frame = {"event": "speech.audio", "segment_index": 0, "is_final": True}
            audio = b"RIFFwav-bytes"
            # publish() is what the TTS worker thread calls.
            threading.Thread(target=broadcaster.publish, args=("session-a", frame, audio)).start()
            return await asyncio.wait_for(queue.get(), timeout=2.0)

        delivered_frame, delivered_audio = asyncio.run(scenario())
        self.assertEqual(delivered_frame["event"], "speech.audio")
        self.assertEqual(delivered_audio, b"RIFFwav-bytes")

    def test_publish_no_subscribers_is_noop(self) -> None:
        async def scenario() -> None:
            broadcaster = SpeechAudioBroadcaster()
            broadcaster.bind_loop(asyncio.get_running_loop())
            self.assertFalse(broadcaster.has_subscribers)
            # No subscribers and no listeners: must not raise.
            broadcaster.publish("nobody", {"event": "speech.audio"}, b"x")

        asyncio.run(scenario())

    def test_publish_only_targets_matching_session(self) -> None:
        async def scenario() -> bool:
            broadcaster = SpeechAudioBroadcaster()
            broadcaster.bind_loop(asyncio.get_running_loop())
            queue_a = broadcaster.subscribe("session-a")
            broadcaster.publish("session-b", {"event": "speech.audio"}, b"x")
            await asyncio.sleep(0)  # let any call_soon_threadsafe drain
            return queue_a.empty()

        self.assertTrue(asyncio.run(scenario()))

    def test_unsubscribe_removes_session(self) -> None:
        broadcaster = SpeechAudioBroadcaster()

        async def scenario() -> None:
            queue = broadcaster.subscribe("session-a")
            broadcaster.unsubscribe("session-a", queue)

        asyncio.run(scenario())
        self.assertFalse(broadcaster.has_subscribers)

    def test_drop_on_full_queue_does_not_raise(self) -> None:
        async def scenario() -> int:
            broadcaster = SpeechAudioBroadcaster()
            broadcaster.bind_loop(asyncio.get_running_loop())
            queue = broadcaster.subscribe("session-a")
            # Fill the queue beyond capacity via the internal offer path.
            item = ({"event": "speech.audio"}, b"x")
            for _ in range(queue.maxsize + 5):
                SpeechAudioBroadcaster._offer(queue, item)
            return queue.qsize()

        self.assertEqual(asyncio.run(scenario()), 128)

    def test_singleton_is_stable(self) -> None:
        self.assertIs(get_speech_audio_broadcaster(), get_speech_audio_broadcaster())


if __name__ == "__main__":
    unittest.main()
