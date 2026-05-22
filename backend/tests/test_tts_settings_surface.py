from __future__ import annotations

import asyncio
import base64
import inspect
import io
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import wave


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.tts_settings_routes import TTSReferenceSettingsRequest, register_tts_settings_routes
from app.services.tts_reference_settings import get_tts_reference_settings, save_tts_reference_settings


class FakeRoute:
    def __init__(self, path: str, endpoint, methods: tuple[str, ...]) -> None:
        self.path = path
        self.endpoint = endpoint
        self.methods = methods


class FakeAPIRouter:
    def __init__(self) -> None:
        self.routes: list[FakeRoute] = []

    def get(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "GET")

    def put(self, path: str, **kwargs):
        del kwargs
        return self._register(path, "PUT")

    def _register(self, path: str, method: str):
        def decorator(endpoint):
            self.routes.append(FakeRoute(path=path, endpoint=endpoint, methods=(method,)))
            return endpoint

        return decorator


class FakeHTTPException(Exception):
    def __init__(self, *, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def get_route(router: FakeAPIRouter, *, path: str, method: str) -> FakeRoute:
    return next(route for route in router.routes if route.path == path and method in route.methods)


def invoke_endpoint(endpoint, **provided_arguments):
    result = endpoint(**provided_arguments)
    if inspect.isawaitable(result):
        return asyncio.run(result)
    return result


def build_wav_base64() -> str:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(24000)
        handle.writeframes(b"\x00\x00" * 240)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class TTSReferenceSettingsTests(unittest.TestCase):
    def test_save_tts_reference_settings_writes_manifest_and_runtime(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            model_root = temp_root / "models" / "tts" / "gpt-sovits"
            model_root.mkdir(parents=True)
            (model_root / "runtime.json").write_text(
                json.dumps({"gpt_model": ".\\pretrained_models\\s1v3.ckpt", "synthesis": {"speaker": "default"}}),
                encoding="utf-8",
            )

            with patch.dict(
                os.environ,
                {
                    "NIKOF_LOCAL_ROOT": str(temp_root),
                    "NIKOF_TTS_MODELS_ROOT": str(temp_root / "models" / "tts"),
                },
                clear=False,
            ):
                snapshot = save_tts_reference_settings(
                    prompt_text="Warm and grounded.",
                    file_name="reference.wav",
                    file_base64=build_wav_base64(),
                )
                runtime_payload = json.loads((model_root / "runtime.json").read_text(encoding="utf-8"))
                speaker_manifest_payload = json.loads((model_root / "speakers" / "default.json").read_text(encoding="utf-8"))

            self.assertTrue(snapshot.configured)
            self.assertEqual("Warm and grounded.", snapshot.prompt_text)
            self.assertEqual("reference-audio/default-reference.wav", speaker_manifest_payload["reference_audio"])
            self.assertEqual("Warm and grounded.", speaker_manifest_payload["prompt_text"])
            self.assertEqual("reference-audio/default-reference.wav", runtime_payload["synthesis"]["reference_audio"])
            self.assertEqual("Warm and grounded.", runtime_payload["synthesis"]["prompt_text"])
            self.assertEqual(".\\pretrained_models\\s1v3.ckpt", runtime_payload["gpt_model"])

    def test_tts_settings_route_rejects_non_wav_upload(self) -> None:
        router = FakeAPIRouter()
        fake_fastapi = type(
            "FakeFastApiModule",
            (),
            {
                "HTTPException": FakeHTTPException,
                "status": type("Status", (), {"HTTP_400_BAD_REQUEST": 400}),
            },
        )

        with patch.dict(sys.modules, {"fastapi": fake_fastapi}):
            register_tts_settings_routes(router)

        endpoint = get_route(router, path="/session/tts/settings", method="PUT").endpoint
        with self.assertRaises(FakeHTTPException) as raised:
            invoke_endpoint(
                endpoint,
                update=TTSReferenceSettingsRequest(
                    prompt_text="Warm and grounded.",
                    file_name="reference.mp3",
                    file_base64=base64.b64encode(b"not-wav").decode("ascii"),
                ),
            )

        self.assertEqual(400, raised.exception.status_code)
        self.assertIn(".wav", raised.exception.detail)

    def test_get_tts_reference_settings_reports_existing_configuration(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            model_root = temp_root / "models" / "tts" / "gpt-sovits"
            (model_root / "reference-audio").mkdir(parents=True)
            (model_root / "speakers").mkdir(parents=True)
            (model_root / "reference-audio" / "default-reference.wav").write_bytes(base64.b64decode(build_wav_base64()))
            (model_root / "runtime.json").write_text(
                json.dumps({"speaker_manifest": "speakers/default.json", "reference_audio_root": "reference-audio"}),
                encoding="utf-8",
            )
            (model_root / "speakers" / "default.json").write_text(
                json.dumps({"reference_audio": "reference-audio/default-reference.wav", "prompt_text": "Warm and grounded."}),
                encoding="utf-8",
            )

            with patch.dict(
                os.environ,
                {
                    "NIKOF_LOCAL_ROOT": str(temp_root),
                    "NIKOF_TTS_MODELS_ROOT": str(temp_root / "models" / "tts"),
                },
                clear=False,
            ):
                snapshot = get_tts_reference_settings()

            self.assertTrue(snapshot.configured)
            self.assertTrue(snapshot.has_reference_audio)
            self.assertEqual("Warm and grounded.", snapshot.prompt_text)
            self.assertEqual("default-reference.wav", snapshot.reference_audio_file_name)


if __name__ == "__main__":
    unittest.main()