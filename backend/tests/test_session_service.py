from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.schemas.character import ActiveCharacterSelection
from app.services.session import InMemorySessionService


class ActiveCharacterPersistenceTests(unittest.TestCase):
    def test_active_character_persists_across_instances(self) -> None:
        with TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "session" / "active-character.json"
            known = frozenset({"test-vrm-01", "test-vrm-02"})

            first = InMemorySessionService(
                default_character_id="test-vrm-01",
                state_path=state_path,
                known_character_ids=known,
            )
            self.assertEqual("test-vrm-01", first.get_snapshot().active_character_id)
            first.set_active_character(ActiveCharacterSelection(character_id="test-vrm-02"))
            self.assertTrue(state_path.exists())

            # A fresh instance (simulating a restart) restores the persisted pick.
            restored = InMemorySessionService(
                default_character_id="test-vrm-01",
                state_path=state_path,
                known_character_ids=known,
            )
            self.assertEqual("test-vrm-02", restored.get_snapshot().active_character_id)

    def test_stale_persisted_character_falls_back_to_default(self) -> None:
        with TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "session" / "active-character.json"
            InMemorySessionService(
                default_character_id="test-vrm-01",
                state_path=state_path,
                known_character_ids=frozenset({"test-vrm-01", "removed-character"}),
            ).set_active_character(ActiveCharacterSelection(character_id="removed-character"))

            # On restore the persisted id is no longer in the allowlist -> default.
            restored = InMemorySessionService(
                default_character_id="test-vrm-01",
                state_path=state_path,
                known_character_ids=frozenset({"test-vrm-01"}),
            )
            self.assertEqual("test-vrm-01", restored.get_snapshot().active_character_id)

    def test_missing_state_file_uses_default(self) -> None:
        with TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "session" / "active-character.json"
            service = InMemorySessionService(default_character_id="test-vrm-01", state_path=state_path)
            self.assertEqual("test-vrm-01", service.get_snapshot().active_character_id)

    def test_no_state_path_is_in_memory_only(self) -> None:
        service = InMemorySessionService(default_character_id="test-vrm-01")
        service.set_active_character(ActiveCharacterSelection(character_id="test-vrm-02"))
        self.assertEqual("test-vrm-02", service.get_snapshot().active_character_id)


if __name__ == "__main__":
    unittest.main()
