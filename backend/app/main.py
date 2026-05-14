from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.api.router import RouteDefinition, build_api_router


@dataclass(slots=True)
class ApplicationShell:
    """Framework-light placeholder until FastAPI is introduced."""

    name: str
    routes: list[RouteDefinition]


def create_app() -> Any:
    """Return a FastAPI app when available, otherwise a simple shell object."""

    router = build_api_router()

    try:
        from fastapi import FastAPI
    except ImportError:
        return ApplicationShell(name="NikoF Backend", routes=router.routes)

    app = FastAPI(title="NikoF Backend", version="0.1.0")
    app.include_router(router)
    return app


app = create_app()


if __name__ == "__main__":
    shell = create_app()

    if isinstance(shell, ApplicationShell):
        for route in shell.routes:
            print(f"{route.method} {route.path} :: {route.name}")
