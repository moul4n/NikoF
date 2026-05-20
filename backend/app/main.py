from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator

from app.api.router import RouteDefinition, build_api_contract_snapshot, build_api_router

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ApplicationShell:
    """Framework-light placeholder until FastAPI is introduced."""

    name: str
    routes: list[RouteDefinition]


@asynccontextmanager
async def _lifespan(app: Any) -> AsyncIterator[None]:
    """Manage async services that need startup/shutdown hooks."""
    # TTS worker temporarily disabled for testing other systems.
    # from app.services.tts_worker import get_tts_worker
    # tts_worker = get_tts_worker()
    # await tts_worker.start()
    # logger.info("TTS worker process loop started (model loads on first request)")

    yield

    # await tts_worker.stop()
    # logger.info("TTS worker shut down")


def create_app() -> Any:
    """Return a FastAPI app when available, otherwise a simple shell object."""

    router = build_api_router()

    try:
        from fastapi import FastAPI
    except ImportError:
        return ApplicationShell(name="NikoF Backend", routes=router.routes)

    app = FastAPI(title="NikoF Backend", version="0.1.0", lifespan=_lifespan)
    app.include_router(router)
    return app


app = create_app()


if __name__ == "__main__":
    shell = create_app()

    if isinstance(shell, ApplicationShell):
        for route in shell.routes:
            print(f"{route.method} {route.path} :: {route.name}")

    print(json.dumps(build_api_contract_snapshot(), indent=2))
