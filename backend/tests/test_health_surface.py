from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from tempfile import TemporaryDirectory
import sys
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.api.response_builders import build_health_payload
from app.core.settings import AppPaths
from app.services.character import CharacterService, FileSystemCharacterManifestSource


REPO_ROOT = BACKEND_ROOT.parents[0]


def build_app_paths(local_root: Path) -> AppPaths:
    assets_root = REPO_ROOT / "assets"
    models_root = local_root / "models"
    return AppPaths(
        repo_root=REPO_ROOT,
        assets_root=assets_root,
        character_assets_root=assets_root / "characters",
        local_data_root=local_root,
        models_root=models_root,
        llm_models_root=models_root / "llm",
        stt_models_root=models_root / "stt",
        tts_models_root=models_root / "tts",
        embeddings_root=models_root / "embeddings",
        providers_root=local_root / "providers",
        cache_root=local_root / "cache",
    )


class HealthSurfaceTests(unittest.TestCase):
    def test_health_payload_projects_frontend_safe_prerequisite_lanes(self) -> None:
        with TemporaryDirectory() as temp_dir:
            app_paths = build_app_paths(Path(temp_dir) / "local")
            stt_model_root = app_paths.stt_models_root / "faster-whisper-medium"
            stt_provider_root = app_paths.providers_root / "stt" / "faster-whisper"
            tts_model_root = app_paths.tts_models_root / "gpt-sovits"
            tts_provider_root = app_paths.providers_root / "tts" / "gpt-sovits"

            stt_model_root.mkdir(parents=True)
            stt_provider_root.mkdir(parents=True)
            tts_model_root.mkdir(parents=True)
            tts_provider_root.mkdir(parents=True)

            (stt_model_root / "runtime.json").write_text("{}", encoding="utf-8")
            (stt_model_root / "install-plan.json").write_text("{}", encoding="utf-8")
            (stt_provider_root / "runtime.json").write_text("{}", encoding="utf-8")
            (tts_model_root / "runtime.json").write_text("{}", encoding="utf-8")
            (tts_model_root / "install-plan.json").write_text("{}", encoding="utf-8")
            (tts_provider_root / "runtime.json").write_text("{}", encoding="utf-8")

            payload = build_health_payload(
                CharacterService(FileSystemCharacterManifestSource()),
                app_paths=app_paths,
            )

        lanes = {lane.id: lane for lane in payload.diagnostics.prerequisite_lanes}
        serialized = asdict(payload)
        serialized_lanes = {
            lane["id"]: lane
            for lane in serialized["diagnostics"]["prerequisite_lanes"]
        }

        self.assertEqual({"llm", "stt", "tts"}, set(lanes.keys()))
        self.assertEqual("missing", lanes["llm"].state)
        self.assertEqual("scaffolded", lanes["stt"].state)
        self.assertEqual("scaffolded", lanes["tts"].state)
        self.assertEqual(
            {
                "llm-model-ollama-llama3.1-8b",
                "provider-ollama",
            },
            {blocker.id for blocker in lanes["llm"].blockers},
        )
        self.assertEqual(
            {
                "missing-faster-whisper-medium-payload-proof",
                "missing-faster-whisper-provider-entrypoint",
            },
            {blocker.id for blocker in lanes["stt"].blockers},
        )
        self.assertEqual(
            {
                "missing-gpt-sovits-payload-proof",
                "missing-gpt-sovits-provider-entrypoint",
            },
            {blocker.id for blocker in lanes["tts"].blockers},
        )
        self.assertEqual(
            {"id", "status", "summary"},
            set(serialized_lanes["llm"]["blockers"][0].keys()),
        )
        self.assertNotIn("expected_path", serialized_lanes["stt"]["blockers"][0])
        self.assertNotIn("remediation", serialized_lanes["tts"]["blockers"][0])


if __name__ == "__main__":
    unittest.main()