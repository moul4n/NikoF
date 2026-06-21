"""Fan-out of synthesized audio chunks to connected WebSocket clients
(Phase 2 increment 2).

The TTS sink runs in a worker *thread* and publishes a segment's audio bytes;
WebSocket handlers run on uvicorn's single asyncio *loop* and subscribe via
per-connection queues. This broadcaster bridges thread -> loop with
``loop.call_soon_threadsafe`` and drops frames for slow consumers rather than
blocking synthesis. The speech.lifecycle event remains the source of truth; the
binary audio frame is an optimization so playback can start without a file
fetch (and so Unity can consume the same stream).
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any


class SpeechAudioBroadcaster:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: dict[str, list[asyncio.Queue]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    @property
    def has_subscribers(self) -> bool:
        with self._lock:
            return any(self._subscribers.values())

    def subscribe(self, session_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=128)
        with self._lock:
            self._subscribers.setdefault(session_id, []).append(queue)
        return queue

    def unsubscribe(self, session_id: str, queue: asyncio.Queue) -> None:
        with self._lock:
            queues = self._subscribers.get(session_id)
            if not queues:
                return
            if queue in queues:
                queues.remove(queue)
            if not queues:
                self._subscribers.pop(session_id, None)

    def publish(self, session_id: str, frame: dict[str, Any], audio: bytes) -> None:
        """Called from the TTS worker thread. No-op when nobody is listening."""
        with self._lock:
            queues = list(self._subscribers.get(session_id, ()))
            loop = self._loop
        if not queues or loop is None:
            return
        item = (frame, audio)
        for queue in queues:
            loop.call_soon_threadsafe(self._offer, queue, item)

    @staticmethod
    def _offer(queue: asyncio.Queue, item: tuple[dict[str, Any], bytes]) -> None:
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            # Slow consumer: drop the chunk rather than stall synthesis. The
            # lifecycle event + artifact fetch remain the reliable fallback.
            pass


_broadcaster: SpeechAudioBroadcaster | None = None
_broadcaster_lock = threading.Lock()


def get_speech_audio_broadcaster() -> SpeechAudioBroadcaster:
    global _broadcaster
    if _broadcaster is None:
        with _broadcaster_lock:
            if _broadcaster is None:
                _broadcaster = SpeechAudioBroadcaster()
    return _broadcaster
