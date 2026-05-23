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
    from app.services.attention_worker import get_attention_worker
    from app.services.llm import get_text_generation_sidecar_manager
    from app.services.stt_worker import get_stt_worker
    from app.services.tts_worker import get_tts_worker

    attention_worker = get_attention_worker()
    llm_sidecar_manager = get_text_generation_sidecar_manager()
    stt_worker = get_stt_worker()
    tts_worker = get_tts_worker()
    await attention_worker.start()
    logger.info("Attention worker started")
    if llm_sidecar_manager.start():
        logger.info("LLM sidecar started")
    await stt_worker.start()
    logger.info("STT worker sidecar started")
    await tts_worker.start()
    logger.info("TTS worker process loop started (model loads on first request)")

    yield

    await attention_worker.stop()
    logger.info("Attention worker shut down")
    llm_sidecar_manager.stop()
    logger.info("LLM sidecar shut down")
    await stt_worker.stop()
    logger.info("STT worker shut down")
    await tts_worker.stop()
    logger.info("TTS worker shut down")


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
