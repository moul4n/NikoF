from __future__ import annotations

import logging
import sys
import unittest
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.access_log import QuietPollingAccessFilter


def _access_record(path: str, status: int, method: str = "GET") -> logging.LogRecord:
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("127.0.0.1:1234", method, path, "1.1", status),
        exc_info=None,
    )


class QuietPollingAccessFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.filter = QuietPollingAccessFilter()

    def test_drops_successful_polling_endpoints(self) -> None:
        for path in (
            "/session/attention/observations",
            "/session/attention",
            "/session/speech-lifecycle?cursor=speech.lifecycle%3As%3A3",
            "/session/stt/devices",
            "/session/display-settings",
            "/session/stage-background",
            "/session/audio-output",
            "/system/resources",
            "/health",
        ):
            self.assertFalse(self.filter.filter(_access_record(path, 200)), path)

    def test_keeps_errors_even_on_polling_endpoints(self) -> None:
        self.assertTrue(self.filter.filter(_access_record("/session/attention/observations", 500)))
        self.assertTrue(self.filter.filter(_access_record("/session/stt", 404)))

    def test_keeps_non_polling_requests(self) -> None:
        for path in (
            "/session/operator-command",
            "/session/characters/maria",
            "/session/tts/kokoro-voice",
        ):
            self.assertTrue(self.filter.filter(_access_record(path, 200)), path)

    def test_tolerates_unexpected_record_shape(self) -> None:
        record = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, "boot complete", None, None)
        self.assertTrue(self.filter.filter(record))


if __name__ == "__main__":
    unittest.main()
