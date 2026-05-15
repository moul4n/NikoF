from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
import unittest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.animation_broadcast import InMemoryAnimationWebSocketBroadcaster


class FakeWebSocket:
    def __init__(self, *, send_raises: bool = False) -> None:
        self.accepted = False
        self.sent_messages: list[str] = []
        self.send_raises = send_raises

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, message: str) -> None:
        if self.send_raises:
            raise RuntimeError("connection closed")
        self.sent_messages.append(message)


class InMemoryAnimationWebSocketBroadcasterTests(unittest.TestCase):
    def test_connect_accepts_websocket_and_tracks_connection(self) -> None:
        broadcaster = InMemoryAnimationWebSocketBroadcaster()
        ws = FakeWebSocket()

        asyncio.run(broadcaster.connect(ws))

        self.assertTrue(ws.accepted)
        self.assertEqual(broadcaster.connection_count, 1)

    def test_disconnect_removes_tracked_connection(self) -> None:
        broadcaster = InMemoryAnimationWebSocketBroadcaster()
        ws = FakeWebSocket()

        asyncio.run(broadcaster.connect(ws))
        broadcaster.disconnect(ws)

        self.assertEqual(broadcaster.connection_count, 0)

    def test_disconnect_unknown_connection_is_noop(self) -> None:
        broadcaster = InMemoryAnimationWebSocketBroadcaster()
        ws = FakeWebSocket()

        broadcaster.disconnect(ws)

        self.assertEqual(broadcaster.connection_count, 0)

    def test_broadcast_sends_json_payload_to_all_connected_clients(self) -> None:
        broadcaster = InMemoryAnimationWebSocketBroadcaster()
        ws1 = FakeWebSocket()
        ws2 = FakeWebSocket()
        asyncio.run(broadcaster.connect(ws1))
        asyncio.run(broadcaster.connect(ws2))

        payload = {
            "animation_id": "idle.default",
            "character_id": "test-vrm-01",
            "state": "idle",
            "intensity": 1.0,
            "parameters": {"source": "shared", "playback": "loop"},
        }
        asyncio.run(broadcaster.broadcast(payload))

        self.assertEqual(len(ws1.sent_messages), 1)
        self.assertEqual(json.loads(ws1.sent_messages[0]), payload)
        self.assertEqual(len(ws2.sent_messages), 1)
        self.assertEqual(json.loads(ws2.sent_messages[0]), payload)

    def test_broadcast_with_no_connections_is_noop(self) -> None:
        broadcaster = InMemoryAnimationWebSocketBroadcaster()
        payload = {
            "animation_id": "idle.default",
            "character_id": "test-vrm-01",
            "state": "idle",
            "intensity": 1.0,
            "parameters": {},
        }

        asyncio.run(broadcaster.broadcast(payload))

        self.assertEqual(broadcaster.connection_count, 0)

    def test_broadcast_prunes_dead_connections_and_delivers_to_live_ones(self) -> None:
        broadcaster = InMemoryAnimationWebSocketBroadcaster()
        ws_dead = FakeWebSocket(send_raises=True)
        ws_alive = FakeWebSocket()
        asyncio.run(broadcaster.connect(ws_dead))
        asyncio.run(broadcaster.connect(ws_alive))

        payload = {
            "animation_id": "emote.acknowledge",
            "character_id": "test-vrm-01",
            "state": "emote",
            "intensity": 1.0,
            "parameters": {},
        }
        asyncio.run(broadcaster.broadcast(payload))

        self.assertEqual(broadcaster.connection_count, 1)
        self.assertEqual(len(ws_alive.sent_messages), 1)
        self.assertEqual(json.loads(ws_alive.sent_messages[0]), payload)

    def test_connection_count_is_zero_on_fresh_broadcaster(self) -> None:
        broadcaster = InMemoryAnimationWebSocketBroadcaster()

        self.assertEqual(broadcaster.connection_count, 0)

    def test_multiple_disconnects_of_same_connection_are_safe(self) -> None:
        broadcaster = InMemoryAnimationWebSocketBroadcaster()
        ws = FakeWebSocket()
        asyncio.run(broadcaster.connect(ws))

        broadcaster.disconnect(ws)
        broadcaster.disconnect(ws)

        self.assertEqual(broadcaster.connection_count, 0)


if __name__ == "__main__":
    unittest.main()
