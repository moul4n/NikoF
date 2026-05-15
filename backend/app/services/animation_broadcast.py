from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol


class AnimationWebSocketBroadcaster(Protocol):
    """Manages live WebSocket connections for pushing animation commands to viewers."""

    async def connect(self, websocket: Any) -> None:
        raise NotImplementedError

    def disconnect(self, websocket: Any) -> None:
        raise NotImplementedError

    async def broadcast(self, payload: dict[str, Any]) -> None:
        raise NotImplementedError

    @property
    def connection_count(self) -> int:
        raise NotImplementedError


@dataclass(slots=True)
class InMemoryAnimationWebSocketBroadcaster:
    """In-process WebSocket connection manager for animation command delivery.

    Accepts WebSocket connections from viewer clients (e.g. the React/three-vrm
    display surface) and broadcasts JSON animation command payloads to all of them.
    Dead connections are pruned automatically on the next broadcast.
    """

    _connections: set[Any] = field(default_factory=set, init=False, repr=False)

    async def connect(self, websocket: Any) -> None:
        await websocket.accept()
        self._connections.add(websocket)

    def disconnect(self, websocket: Any) -> None:
        self._connections.discard(websocket)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self._connections:
            return

        message = json.dumps(payload)
        dead: list[Any] = []

        for ws in list(self._connections):
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)

        for ws in dead:
            self._connections.discard(ws)

    @property
    def connection_count(self) -> int:
        return len(self._connections)
