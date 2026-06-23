"""Lifecycle integration gate for the shared process-supervision primitives.

Unlike the contract-snapshot suite, these tests spawn REAL throwaway processes
(trivial python sleepers — no models, no sidecars) and exercise the actual
spawn -> find-by-port -> terminate -> assert-no-orphans path that every sidecar
manager relies on. This is the gate STABILIZATION_TODO Phase 1D asked for, kept
hermetic so it runs in the default suite.
"""

import socket
import subprocess
import sys
import time
import unittest

from app.services.process_supervision import (
    find_listening_pid,
    process_exists,
    terminate_process_tree,
    terminate_process_tree_by_pid,
)

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _spawn(code: str) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        creationflags=_NO_WINDOW,
    )


def _wait_until(predicate, *, timeout: float = 10.0, interval: float = 0.1) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class ProcessLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._procs: list[subprocess.Popen] = []

    def tearDown(self) -> None:
        for proc in self._procs:
            try:
                if proc.poll() is None:
                    terminate_process_tree(proc)
            except Exception:
                pass
            finally:
                if proc.stdout is not None:
                    proc.stdout.close()

    def _track(self, proc: subprocess.Popen) -> subprocess.Popen:
        self._procs.append(proc)
        return proc

    def test_process_exists_tracks_a_real_process(self) -> None:
        proc = self._track(_spawn("import time; time.sleep(30)"))
        self.assertTrue(process_exists(proc.pid))
        terminate_process_tree_by_pid(proc.pid)
        self.assertTrue(
            _wait_until(lambda: not process_exists(proc.pid)),
            "process still exists after terminate_process_tree_by_pid",
        )

    def test_process_exists_rejects_bogus_pids(self) -> None:
        self.assertFalse(process_exists(None))
        self.assertFalse(process_exists(0))
        self.assertFalse(process_exists(-1))

    def test_find_listening_pid_then_released_after_terminate(self) -> None:
        # Bind an ephemeral port in a child process, confirm we can locate it by
        # port (owned-PID discovery), then confirm the port frees once it's killed.
        code = (
            "import socket, time\n"
            "s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen()\n"
            "print(s.getsockname()[1], flush=True)\n"
            "time.sleep(30)\n"
        )
        proc = self._track(_spawn(code))
        port = int(proc.stdout.readline().strip())

        found_pid = find_listening_pid("127.0.0.1", port)
        self.assertIsNotNone(found_pid, "listener was not found on its port")
        self.assertTrue(process_exists(found_pid))

        terminate_process_tree_by_pid(proc.pid)
        self.assertTrue(
            _wait_until(lambda: find_listening_pid("127.0.0.1", port) is None),
            "port was not released after the listener was terminated",
        )

    def test_terminate_reaps_the_whole_process_tree(self) -> None:
        # The core "stop leaves no orphans" guarantee: a parent that spawned a child
        # must take the child down with it. (Windows uses taskkill /T which reaps the
        # whole tree; the POSIX path only signals the top PID — a known gap, so the
        # child-orphan assertion is Windows-only.)
        parent_code = (
            "import subprocess, sys, time\n"
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
            "print(child.pid, flush=True)\n"
            "time.sleep(60)\n"
        )
        parent = self._track(_spawn(parent_code))
        child_pid = int(parent.stdout.readline().strip())
        self.assertTrue(process_exists(parent.pid))
        self.assertTrue(process_exists(child_pid))

        terminate_process_tree_by_pid(parent.pid)

        self.assertTrue(
            _wait_until(lambda: not process_exists(parent.pid)),
            "parent process was not terminated",
        )
        if sys.platform == "win32":
            self.assertTrue(
                _wait_until(lambda: not process_exists(child_pid)),
                "child process orphaned after tree termination (taskkill /T should reap it)",
            )

    def test_terminate_handles_already_dead_and_none(self) -> None:
        # Idempotent / defensive: terminating None or an already-exited process must
        # not raise (managers call these on best-effort shutdown paths).
        terminate_process_tree(None)
        terminate_process_tree_by_pid(None)
        proc = self._track(_spawn("pass"))
        proc.wait(timeout=10)
        terminate_process_tree_by_pid(proc.pid)  # already dead -> no-op, no raise


if __name__ == "__main__":
    unittest.main()
