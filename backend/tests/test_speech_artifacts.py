from __future__ import annotations

import sys
from pathlib import Path
import unittest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.schemas.session import SessionEvent, SpeechSynthesisContract
from app.services import speech, speech_artifacts


class SpeechArtifactsModuleTests(unittest.TestCase):
    def test_speech_reexports_artifact_helpers(self) -> None:
        # The split must preserve `app.services.speech.X` for operator_routes,
        # turns, tts_worker, and session_routes.
        self.assertIs(speech.project_public_session_event, speech_artifacts.project_public_session_event)
        self.assertIs(
            speech.build_public_speech_audio_reference,
            speech_artifacts.build_public_speech_audio_reference,
        )
        self.assertIs(speech._normalize_audio_reference, speech_artifacts._normalize_audio_reference)
        self.assertEqual(
            speech.PUBLIC_SESSION_SPEECH_ARTIFACT_PREFIX,
            speech_artifacts.PUBLIC_SESSION_SPEECH_ARTIFACT_PREFIX,
        )

    def test_build_public_reference_uses_prefix(self) -> None:
        self.assertEqual(
            speech_artifacts.build_public_speech_audio_reference(event_id="evt-1"),
            "/api/session/speech-artifacts/evt-1/audio",
        )

    def test_project_passthrough_when_no_audio_reference(self) -> None:
        event = SessionEvent(
            schema_version=2,
            event_type="speech.synthesis",
            session_id="s1",
            character_id="niko",
            status="ready",
            timestamp="2026-06-21T00:00:00Z",
            synthesis=SpeechSynthesisContract(
                profile_id="tts.gpt-sovits.2026-stable",
                status="ready",
                text="Hi.",
                locale="en-US",
                audio_reference=None,
            ),
        )
        # No audio_reference and no audio_event_id -> unchanged (same object).
        self.assertIs(speech_artifacts.project_public_session_event(event), event)

    def test_project_passthrough_for_session_scoped_reference(self) -> None:
        event = SessionEvent(
            schema_version=2,
            event_type="speech.synthesis",
            session_id="s1",
            character_id="niko",
            status="ready",
            timestamp="2026-06-21T00:00:00Z",
            synthesis=SpeechSynthesisContract(
                profile_id="tts.gpt-sovits.2026-stable",
                status="ready",
                text="Hi.",
                locale="en-US",
                audio_reference="session://speech-sample/clip.wav",
            ),
        )
        # session:// is not a machine-local path -> left untouched (no rewrite).
        projected = speech_artifacts.project_public_session_event(event, audio_event_id="evt-1")
        self.assertEqual(projected.synthesis.audio_reference, "session://speech-sample/clip.wav")

    def test_machine_local_detection(self) -> None:
        self.assertFalse(speech_artifacts._looks_like_machine_local_audio_reference("session://x"))
        self.assertFalse(speech_artifacts._looks_like_machine_local_audio_reference("https://x/y.wav"))
        self.assertFalse(speech_artifacts._looks_like_machine_local_audio_reference(""))
        self.assertTrue(speech_artifacts._looks_like_machine_local_audio_reference(r"C:\models\clip.wav"))


if __name__ == "__main__":
    unittest.main()
