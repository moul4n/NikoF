from __future__ import annotations

import sys
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.resource_monitor import GpuSnapshot, ResourceMonitor, _try_nvidia_smi_gpu_snapshot


def make_gpu_snapshot(*, total_mb: float, free_mb: float) -> GpuSnapshot:
    return GpuSnapshot(
        device_index=0,
        device_name="Test GPU",
        vram_total_mb=total_mb,
        vram_used_mb=total_mb - free_mb,
        vram_free_mb=free_mb,
        utilization_percent=10.0,
    )


class ResourceMonitorPolicyTests(unittest.TestCase):
    def test_nvidia_smi_gpu_snapshot_fallback_parses_totals(self) -> None:
        result = CompletedProcess(
            args=["nvidia-smi"],
            returncode=0,
            stdout="0, NVIDIA GeForce RTX 4070, 12282, 1400, 7\n",
            stderr="",
        )

        with patch("app.services.resource_monitor.subprocess.run", return_value=result):
            snapshot = _try_nvidia_smi_gpu_snapshot()

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(12282.0, snapshot.vram_total_mb)
        self.assertEqual(1400.0, snapshot.vram_used_mb)
        self.assertEqual(10882.0, snapshot.vram_free_mb)
        self.assertEqual(7.0, snapshot.utilization_percent)

    def test_stt_defaults_to_cpu_on_12gb_gpu(self) -> None:
        monitor = ResourceMonitor()

        with patch(
            "app.services.resource_monitor._try_gpu_snapshot",
            return_value=make_gpu_snapshot(total_mb=12288.0, free_mb=9000.0),
        ):
            allowed = monitor.can_load_subsystem("stt", 2200.0)

        self.assertFalse(allowed)

    def test_stt_can_use_gpu_above_12gb_when_headroom_exists(self) -> None:
        monitor = ResourceMonitor()

        with patch(
            "app.services.resource_monitor._try_gpu_snapshot",
            return_value=make_gpu_snapshot(total_mb=16384.0, free_mb=9000.0),
        ):
            allowed = monitor.can_load_subsystem("stt", 2200.0)

        self.assertTrue(allowed)

    def test_other_subsystems_keep_existing_vram_check(self) -> None:
        monitor = ResourceMonitor()

        with patch(
            "app.services.resource_monitor._try_gpu_snapshot",
            return_value=make_gpu_snapshot(total_mb=12288.0, free_mb=4000.0),
        ):
            allowed = monitor.can_load_subsystem("tts", 3500.0)

        self.assertTrue(allowed)


if __name__ == "__main__":
    unittest.main()