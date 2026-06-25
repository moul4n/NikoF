"""Quiet down the uvicorn access log on the dev terminal.

The frontend polls a handful of endpoints every couple of seconds (attention,
speech lifecycle, STT, display settings, background, audio output, resources) and
the webcam capture path POSTs attention observations several times a second. Past
the root debugging phase, those successful 2xx lines are pure noise that buries
anything useful. This installs a filter on the ``uvicorn.access`` logger that
drops the successful polling lines while always keeping errors (>= 400) and any
non-polling request visible.

Toggle off with ``NIKOF_QUIET_ACCESS_LOG=0`` to get the full firehose back for
debugging.
"""

from __future__ import annotations

import logging
import os


# Successful access-log lines for these path prefixes are suppressed. Keep this
# to genuinely high-frequency polling/streaming endpoints so real requests
# (operator commands, character loads, saves, errors) still show up.
_QUIET_ACCESS_PREFIXES: tuple[str, ...] = (
    "/session/attention",
    "/session/speech-lifecycle",
    "/session/stt",
    "/session/display-settings",
    "/session/stage-background",
    "/session/audio-output",
    "/session/animation",
    "/system/resources",
    "/health",
)


class QuietPollingAccessFilter(logging.Filter):
    """Drop successful access-log records for the high-frequency poll endpoints.

    uvicorn logs access lines as ``logger.info(fmt, client, method, path,
    http_version, status)`` so ``record.args`` is that 5-tuple; we read the path
    (args[2]) and status (args[4])."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not isinstance(args, tuple) or len(args) < 5:
            return True

        path, status = args[2], args[4]
        if not isinstance(path, str):
            return True

        try:
            status_code = int(status)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return True

        # Always surface errors, even for the polling endpoints.
        if status_code >= 400:
            return True

        path_only = path.split("?", 1)[0]
        return not path_only.startswith(_QUIET_ACCESS_PREFIXES)


def install_quiet_access_log_filter() -> None:
    """Attach the polling filter to ``uvicorn.access`` (idempotent, env-gated)."""
    if os.environ.get("NIKOF_QUIET_ACCESS_LOG", "1").strip().lower() in ("0", "false", "no"):
        return

    access_logger = logging.getLogger("uvicorn.access")
    if any(isinstance(existing, QuietPollingAccessFilter) for existing in access_logger.filters):
        return

    access_logger.addFilter(QuietPollingAccessFilter())
