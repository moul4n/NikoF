"""Backend-focused test package.

Test isolation guard
--------------------
On a developer machine the real model/provider roots (NIKOF_LOCAL_ROOT and
friends) point at installed Faster-Whisper / GPT-SoVITS / Ollama payloads. If
the test suite resolves those, sidecar managers consider themselves
"configured" and `unittest discover` will spawn the REAL sidecars — loading
models into VRAM, binding sidecar ports, and hanging or colliding with a live
stack.

To keep the suite hermetic, point every NIKOF_* root at a throwaway temp
directory before any test module imports the app. Because get_app_paths()
re-reads these env vars on each call (it is not cached), every sidecar manager
then resolves to "not configured" and starts nothing.

Set NIKOF_TEST_USE_REAL_ROOT=1 to opt out (e.g. for an intentional integration
run against installed providers).
"""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile

if os.environ.get("NIKOF_TEST_USE_REAL_ROOT") != "1":
    _isolated_root = tempfile.mkdtemp(prefix="nikof-test-root-")

    # Override (not setdefault): the developer's real NIKOF_LOCAL_ROOT is
    # exactly what we must neutralize.
    os.environ["NIKOF_LOCAL_ROOT"] = _isolated_root
    for _key in (
        "NIKOF_MODELS_ROOT",
        "NIKOF_LLM_MODELS_ROOT",
        "NIKOF_STT_MODELS_ROOT",
        "NIKOF_TTS_MODELS_ROOT",
        "NIKOF_EMBEDDINGS_ROOT",
        "NIKOF_PROVIDERS_ROOT",
        "NIKOF_CACHE_ROOT",
    ):
        os.environ.pop(_key, None)

    @atexit.register
    def _cleanup_isolated_root() -> None:
        shutil.rmtree(_isolated_root, ignore_errors=True)
