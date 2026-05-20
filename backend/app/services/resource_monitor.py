"""System resource monitoring for all AI model subsystems (LLM, TTS, STT).

Tracks GPU VRAM, system RAM, and per-subsystem model load state so the
orchestrator can avoid overcommitting shared hardware resources.
"""

from __future__ import annotations

import os
import time
import threading
from dataclasses import dataclass, field
from typing import Any, Literal

ModelSubsystem = Literal["llm", "tts", "stt", "embeddings"]

_POLL_INTERVAL_SECONDS = 2.0


@dataclass(slots=True, frozen=True)
class GpuSnapshot:
    device_index: int
    device_name: str
    vram_total_mb: float
    vram_used_mb: float
    vram_free_mb: float
    utilization_percent: float | None


@dataclass(slots=True, frozen=True)
class SystemMemorySnapshot:
    ram_total_mb: float
    ram_used_mb: float
    ram_available_mb: float
    ram_percent: float


@dataclass(slots=True, frozen=True)
class SubsystemStatus:
    subsystem: ModelSubsystem
    loaded: bool
    model_name: str | None
    vram_allocated_mb: float | None
    ram_allocated_mb: float | None
    last_request_epoch: float | None
    requests_processed: int
    average_latency_ms: float | None


@dataclass(slots=True, frozen=True)
class ResourceSnapshot:
    timestamp_epoch: float
    gpu: GpuSnapshot | None
    system_memory: SystemMemorySnapshot
    subsystems: tuple[SubsystemStatus, ...]
    warnings: tuple[str, ...]


def _try_gpu_snapshot() -> GpuSnapshot | None:
    """Attempt to read GPU stats via torch.cuda or pynvml."""
    try:
        import torch

        if not torch.cuda.is_available():
            return None

        device_index = torch.cuda.current_device()
        device_name = torch.cuda.get_device_name(device_index)
        mem = torch.cuda.mem_get_info(device_index)
        free_bytes, total_bytes = mem
        used_bytes = total_bytes - free_bytes

        utilization: float | None = None
        try:
            import pynvml

            pynvml.nvmlInit()
            handle = pynvml.nvmlDeviceGetHandleByIndex(device_index)
            util_rates = pynvml.nvmlDeviceGetUtilizationRates(handle)
            utilization = float(util_rates.gpu)
        except Exception:
            pass

        return GpuSnapshot(
            device_index=device_index,
            device_name=device_name,
            vram_total_mb=total_bytes / (1024 * 1024),
            vram_used_mb=used_bytes / (1024 * 1024),
            vram_free_mb=free_bytes / (1024 * 1024),
            utilization_percent=utilization,
        )
    except Exception:
        return None


def _system_memory_snapshot() -> SystemMemorySnapshot:
    """Read system RAM usage via psutil or fallback."""
    try:
        import psutil

        vm = psutil.virtual_memory()
        return SystemMemorySnapshot(
            ram_total_mb=vm.total / (1024 * 1024),
            ram_used_mb=vm.used / (1024 * 1024),
            ram_available_mb=vm.available / (1024 * 1024),
            ram_percent=vm.percent,
        )
    except ImportError:
        # Fallback for Windows without psutil
        try:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(stat)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))

            total = stat.ullTotalPhys
            available = stat.ullAvailPhys
            used = total - available
            percent = (used / total) * 100 if total else 0.0

            return SystemMemorySnapshot(
                ram_total_mb=total / (1024 * 1024),
                ram_used_mb=used / (1024 * 1024),
                ram_available_mb=available / (1024 * 1024),
                ram_percent=percent,
            )
        except Exception:
            return SystemMemorySnapshot(
                ram_total_mb=0,
                ram_used_mb=0,
                ram_available_mb=0,
                ram_percent=0,
            )


@dataclass
class SubsystemTracker:
    """Mutable tracker for a single model subsystem."""

    subsystem: ModelSubsystem
    loaded: bool = False
    model_name: str | None = None
    vram_allocated_mb: float | None = None
    ram_allocated_mb: float | None = None
    last_request_epoch: float | None = None
    requests_processed: int = 0
    _latency_sum_ms: float = 0.0

    def record_request(self, latency_ms: float) -> None:
        self.requests_processed += 1
        self._latency_sum_ms += latency_ms
        self.last_request_epoch = time.time()

    def mark_loaded(self, model_name: str, vram_mb: float | None = None, ram_mb: float | None = None) -> None:
        self.loaded = True
        self.model_name = model_name
        self.vram_allocated_mb = vram_mb
        self.ram_allocated_mb = ram_mb

    def mark_unloaded(self) -> None:
        self.loaded = False
        self.model_name = None
        self.vram_allocated_mb = None
        self.ram_allocated_mb = None

    def snapshot(self) -> SubsystemStatus:
        avg_latency: float | None = None
        if self.requests_processed > 0:
            avg_latency = self._latency_sum_ms / self.requests_processed

        return SubsystemStatus(
            subsystem=self.subsystem,
            loaded=self.loaded,
            model_name=self.model_name,
            vram_allocated_mb=self.vram_allocated_mb,
            ram_allocated_mb=self.ram_allocated_mb,
            last_request_epoch=self.last_request_epoch,
            requests_processed=self.requests_processed,
            average_latency_ms=avg_latency,
        )


# Budget thresholds for the 12 GB baseline card
VRAM_BUDGET_MB = float(os.environ.get("NIKOF_VRAM_BUDGET_MB", "12288"))
VRAM_WARNING_THRESHOLD = 0.85  # warn at 85% usage
RAM_WARNING_THRESHOLD = 0.90   # warn at 90% usage


class ResourceMonitor:
    """Singleton-style monitor aggregating all subsystem resource metrics."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._trackers: dict[ModelSubsystem, SubsystemTracker] = {
            "llm": SubsystemTracker(subsystem="llm"),
            "tts": SubsystemTracker(subsystem="tts"),
            "stt": SubsystemTracker(subsystem="stt"),
            "embeddings": SubsystemTracker(subsystem="embeddings"),
        }
        self._last_snapshot: ResourceSnapshot | None = None
        self._last_snapshot_time: float = 0.0

    def tracker(self, subsystem: ModelSubsystem) -> SubsystemTracker:
        return self._trackers[subsystem]

    def snapshot(self, *, force_refresh: bool = False) -> ResourceSnapshot:
        now = time.time()
        if not force_refresh and self._last_snapshot is not None:
            if now - self._last_snapshot_time < _POLL_INTERVAL_SECONDS:
                return self._last_snapshot

        gpu = _try_gpu_snapshot()
        system_memory = _system_memory_snapshot()

        with self._lock:
            subsystems = tuple(t.snapshot() for t in self._trackers.values())

        warnings: list[str] = []
        if gpu is not None:
            used_ratio = gpu.vram_used_mb / gpu.vram_total_mb if gpu.vram_total_mb else 0
            if used_ratio >= VRAM_WARNING_THRESHOLD:
                warnings.append(
                    f"GPU VRAM usage at {used_ratio * 100:.0f}% "
                    f"({gpu.vram_used_mb:.0f}/{gpu.vram_total_mb:.0f} MB)"
                )

        if system_memory.ram_percent >= RAM_WARNING_THRESHOLD * 100:
            warnings.append(
                f"System RAM usage at {system_memory.ram_percent:.0f}% "
                f"({system_memory.ram_used_mb:.0f}/{system_memory.ram_total_mb:.0f} MB)"
            )

        snap = ResourceSnapshot(
            timestamp_epoch=now,
            gpu=gpu,
            system_memory=system_memory,
            subsystems=subsystems,
            warnings=tuple(warnings),
        )
        self._last_snapshot = snap
        self._last_snapshot_time = now
        return snap

    def can_load_subsystem(self, subsystem: ModelSubsystem, estimated_vram_mb: float) -> bool:
        """Check if there's enough VRAM headroom to load a subsystem."""
        gpu = _try_gpu_snapshot()
        if gpu is None:
            return True  # No GPU info means we can't block

        return gpu.vram_free_mb >= estimated_vram_mb


# Module-level singleton
_resource_monitor: ResourceMonitor | None = None
_resource_monitor_lock = threading.Lock()


def get_resource_monitor() -> ResourceMonitor:
    global _resource_monitor
    if _resource_monitor is None:
        with _resource_monitor_lock:
            if _resource_monitor is None:
                _resource_monitor = ResourceMonitor()
    return _resource_monitor
