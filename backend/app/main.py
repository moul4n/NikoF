from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator

from app.api.router import RouteDefinition, build_api_contract_snapshot, build_api_router

logger = logging.getLogger(__name__)

# Local desktop/web clients allowed to call the API cross-origin. The web UI is
# served same-origin via the Vite proxy; the Tauri shell and future native clients
# load from their own origin and need an explicit allowlist.
_DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://tauri.localhost",
    "tauri://localhost",
    "https://tauri.localhost",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
)


def _resolve_cors_origins() -> list[str]:
    """Allowed CORS origins, with optional comma-separated env additions."""
    origins = list(_DEFAULT_CORS_ORIGINS)
    extra = os.environ.get("NIKOF_EXTRA_CORS_ORIGINS", "").strip()
    if extra:
        origins.extend(origin.strip() for origin in extra.split(",") if origin.strip())
    return origins


@dataclass(slots=True)
class ApplicationShell:
    """Framework-light placeholder until FastAPI is introduced."""

    name: str
    routes: list[RouteDefinition]


@asynccontextmanager
async def _lifespan(app: Any) -> AsyncIterator[None]:
    """Manage async services that need startup/shutdown hooks."""
    from app.core.access_log import install_quiet_access_log_filter

    # Quiet the per-poll access-log spam on the dev terminal (errors still show).
    install_quiet_access_log_filter()

    from app.core.runtime_tuning import get_runtime_tuning
    from app.services.attention_worker import get_attention_worker
    from app.services.llm import TextGenerationRequest, get_text_generation_sidecar_manager
    from app.services.memory_consolidation import get_memory_consolidation_worker
    from app.services.stt_worker import get_stt_worker
    from app.services.tts_worker import get_tts_worker

    tuning = get_runtime_tuning()
    attention_worker = get_attention_worker()
    llm_sidecar_manager = get_text_generation_sidecar_manager()
    stt_worker = get_stt_worker()
    tts_worker = get_tts_worker()
    memory_consolidation_worker = get_memory_consolidation_worker(
        text_generation_service=llm_sidecar_manager.resolve(
            TextGenerationRequest(prompt="", locale="en-US")
        )
    )
    await attention_worker.start()
    logger.info("Attention worker started")
    llm_started = llm_sidecar_manager.start()
    if llm_started:
        logger.info("LLM sidecar started")
    await stt_worker.start()
    logger.info("STT worker sidecar started")
    await tts_worker.start()
    logger.info("TTS worker process loop started (model loads on first request)")
    if memory_consolidation_worker.start():
        logger.info("Memory consolidation worker started (idle-gated)")

    # Phase 0 warmups: pay the model lazy-load cost at startup instead of on the
    # first user turn. TTS warmup is already non-blocking; the LLM warmup sends a
    # tiny generation, so run it off the event loop and never block startup on it.
    warm_llm_task: asyncio.Task[None] | None = None
    if tuning.warm_tts_on_start:
        from app.services.tts_engines import build_alternate_synthesis_service, resolve_tts_engine_name

        engine_name = resolve_tts_engine_name()
        alternate_tts = build_alternate_synthesis_service(engine_name)
        if alternate_tts is not None:
            # Selected engine is an in-process adapter (kokoro/xtts) — warm it
            # (GPT-SoVITS stays unloaded since the worker isn't the synth path).
            alternate_tts.request_warmup()
            logger.info("TTS warmup scheduled (%s)", engine_name)
        elif tts_worker.request_warmup():
            logger.info("TTS warmup scheduled (gpt-sovits)")
    if tuning.warm_llm_on_start and llm_started:
        async def _warm_llm() -> None:
            try:
                await asyncio.to_thread(llm_sidecar_manager.warmup)
                logger.info("LLM warmup complete")
            except Exception:  # pragma: no cover - warmup is best-effort
                logger.warning("LLM warmup failed; first turn will pay load cost", exc_info=True)

        warm_llm_task = asyncio.create_task(_warm_llm())

    yield

    if warm_llm_task is not None and not warm_llm_task.done():
        warm_llm_task.cancel()

    memory_consolidation_worker.stop()
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
        from fastapi.middleware.cors import CORSMiddleware
    except ImportError:
        return ApplicationShell(name="NikoF Backend", routes=router.routes)

    app = FastAPI(title="NikoF Backend", version="0.1.0", lifespan=_lifespan)
    # Local-only origins. The web frontend reaches the backend same-origin through
    # the Vite dev proxy, but the Tauri desktop shell (and the future Unity client)
    # load from a different origin and call the API directly, so they need CORS.
    # The WebView2 origin on Windows is http://tauri.localhost; other platforms use
    # tauri://localhost. Extra origins can be appended via NIKOF_EXTRA_CORS_ORIGINS
    # (comma-separated).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_resolve_cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    return app


app = create_app()


if __name__ == "__main__":
    shell = create_app()

    if isinstance(shell, ApplicationShell):
        for route in shell.routes:
            print(f"{route.method} {route.path} :: {route.name}")

    print(json.dumps(build_api_contract_snapshot(), indent=2))
