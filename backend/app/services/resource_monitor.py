"""System resource monitoring for all AI model subsystems (LLM, TTS, STT).

Tracks GPU VRAM, system RAM, and per-subsystem model load state so the
orchestrator can avoid overcommitting shared hardware resources.
"""

from __future__ import annotations

import csv
import os
from pathlib import Path
import subprocess
import time
import threading
from dataclasses import dataclass, field, replace
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
class GpuProcessSnapshot:
    pid: int
    process_name: str
    used_memory_mb: float | None
    gpu_uuid: str | None


@dataclass(slots=True, frozen=True)
class OwnedProcessSnapshot:
    pid: int
    parent_pid: int | None
    label: str
    process_name: str
    executable: str | None
    command: str | None
    status: str | None
    rss_mb: float | None
    gpu_memory_mb: float | None


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
    gpu_processes: tuple[GpuProcessSnapshot, ...]
    owned_processes: tuple[OwnedProcessSnapshot, ...]
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
        return _try_nvidia_smi_gpu_snapshot()


def _try_nvidia_smi_gpu_snapshot() -> GpuSnapshot | None:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.total,memory.used,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if completed.returncode != 0 or not completed.stdout.strip():
        return None

    reader = csv.reader(completed.stdout.splitlines())
    first_row = next(reader, None)
    if first_row is None or len(first_row) < 5:
        return None

    try:
        device_index = int(first_row[0].strip())
        device_name = first_row[1].strip()
        total_mb = float(first_row[2].strip())
        used_mb = float(first_row[3].strip())
    except ValueError:
        return None

    utilization_raw = first_row[4].strip()
    try:
        utilization = float(utilization_raw)
    except ValueError:
        utilization = None

    return GpuSnapshot(
        device_index=device_index,
        device_name=device_name,
        vram_total_mb=total_mb,
        vram_used_mb=used_mb,
        vram_free_mb=max(total_mb - used_mb, 0.0),
        utilization_percent=utilization,
    )


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


def _coerce_pid(raw_value: str) -> int | None:
    try:
        return int(raw_value.strip())
    except (TypeError, ValueError, AttributeError):
        return None


def _coerce_memory_mb(raw_value: str) -> float | None:
    normalized = str(raw_value or "").strip()
    if not normalized or normalized.upper() == "[N/A]":
        return None
    try:
        return float(normalized)
    except ValueError:
        return None


def _gpu_processes_snapshot() -> tuple[GpuProcessSnapshot, ...]:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,process_name,used_memory,gpu_uuid",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return tuple()

    if completed.returncode != 0 or not completed.stdout.strip():
        return tuple()

    parsed_rows: list[GpuProcessSnapshot] = []
    reader = csv.reader(completed.stdout.splitlines())
    for row in reader:
        if len(row) < 4:
            continue
        pid = _coerce_pid(row[0])
        if pid is None:
            continue
        parsed_rows.append(
            GpuProcessSnapshot(
                pid=pid,
                process_name=row[1].strip(),
                used_memory_mb=_coerce_memory_mb(row[2]),
                gpu_uuid=row[3].strip() or None,
            )
        )

    return tuple(sorted(parsed_rows, key=lambda item: (item.used_memory_mb or -1), reverse=True))


def _label_owned_process(command: str | None, process_name: str, *, current_pid: int, pid: int) -> str:
    if pid == current_pid:
        return "backend"

    normalized_name = process_name.lower()
    normalized_command = (command or "").lower()
    if any(server_script in normalized_command for server_script in ("api_v2.py", "api.py", "api_server.py")):
        return "tts-sidecar"
    if "synthesize.py" in normalized_command:
        return "tts-entrypoint"
    if normalized_name in {"ollama.exe", "ollama"} and " runner " in f" {normalized_command} ":
        return "llm-runner"
    if normalized_name in {"ollama.exe", "ollama"} or "ollama" in normalized_command:
        return "llm-sidecar"
    if "llama.cpp" in normalized_command or "llama-server" in normalized_command:
        return "llm-sidecar"
    if "transcribe.py" in normalized_command:
        return "stt-sidecar"
    if "main.py" in normalized_command and "providers\\stt\\faster-whisper" in normalized_command:
        return "stt-sidecar"
    if "/stt/faster-whisper" in normalized_command and "main.py" in normalized_command:
        return "stt-sidecar"
    if "uvicorn" in normalized_command:
        return "backend-worker"
    if normalized_name in {"python.exe", "python", "pwsh.exe", "pwsh"}:
        return "backend-child"
    return "backend-child"


def _owned_processes_snapshot(
    gpu_processes: tuple[GpuProcessSnapshot, ...],
) -> tuple[OwnedProcessSnapshot, ...]:
    try:
        import psutil
    except ImportError:
        return tuple()

    gpu_memory_by_pid = {
        process.pid: process.used_memory_mb
        for process in gpu_processes
        if process.used_memory_mb is not None
    }

    current_process = psutil.Process()
    process_candidates = [current_process, *current_process.children(recursive=True)]
    owned_processes: list[OwnedProcessSnapshot] = []

    for process in process_candidates:
        try:
            with process.oneshot():
                pid = process.pid
                parent = process.ppid()
                name = process.name()
                executable = process.exe() or None
                command_parts = process.cmdline()
                command = " ".join(command_parts).strip() or None
                status = process.status()
                memory_info = process.memory_info()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            continue

        owned_processes.append(
            OwnedProcessSnapshot(
                pid=pid,
                parent_pid=parent,
                label=_label_owned_process(command, name, current_pid=current_process.pid, pid=pid),
                process_name=name,
                executable=executable,
                command=command,
                status=status,
                rss_mb=memory_info.rss / (1024 * 1024),
                gpu_memory_mb=gpu_memory_by_pid.get(pid),
            )
        )

    return tuple(sorted(owned_processes, key=lambda item: (item.label != "backend", item.pid)))


def _apply_owned_process_gpu_fallbacks(
    owned_processes: tuple[OwnedProcessSnapshot, ...],
    subsystems: tuple[SubsystemStatus, ...],
) -> tuple[OwnedProcessSnapshot, ...]:
    subsystem_candidates: dict[ModelSubsystem, tuple[str, ...]] = {
        "tts": ("tts-sidecar", "tts-entrypoint"),
        "llm": ("llm-runner", "llm-sidecar"),
        "stt": ("stt-sidecar",),
        "embeddings": tuple(),
    }
    subsystem_by_label: dict[str, SubsystemStatus] = {}
    for subsystem in subsystems:
        if not subsystem.loaded or subsystem.vram_allocated_mb is None:
            continue
        for label in subsystem_candidates.get(subsystem.subsystem, tuple()):
            subsystem_by_label[label] = subsystem

    explicit_gpu_subsystems = {
        subsystem_by_label[process.label].subsystem
        for process in owned_processes
        if process.gpu_memory_mb is not None and process.label in subsystem_by_label
    }

    fallback_target_pid_by_subsystem: dict[ModelSubsystem, int] = {}
    for subsystem_name, labels in subsystem_candidates.items():
        if subsystem_name in explicit_gpu_subsystems:
            continue
        for label in labels:
            target = next(
                (
                    process
                    for process in owned_processes
                    if process.label == label and process.gpu_memory_mb is None
                ),
                None,
            )
            if target is not None:
                fallback_target_pid_by_subsystem[subsystem_name] = target.pid
                break

    adjusted: list[OwnedProcessSnapshot] = []
    for process in owned_processes:
        if process.gpu_memory_mb is not None:
            adjusted.append(process)
            continue

        subsystem = subsystem_by_label.get(process.label)
        if subsystem is None:
            adjusted.append(process)
            continue

        if fallback_target_pid_by_subsystem.get(subsystem.subsystem) != process.pid:
            adjusted.append(process)
            continue

        adjusted.append(replace(process, gpu_memory_mb=subsystem.vram_allocated_mb))

    return tuple(adjusted)


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
STT_GPU_CPU_DEFAULT_CUTOFF_MB = float(os.environ.get("NIKOF_STT_GPU_CPU_DEFAULT_CUTOFF_MB", "12288"))
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
        gpu_processes = _gpu_processes_snapshot()
        owned_processes = _owned_processes_snapshot(gpu_processes)
        system_memory = _system_memory_snapshot()

        with self._lock:
            subsystems = tuple(t.snapshot() for t in self._trackers.values())

        owned_processes = _apply_owned_process_gpu_fallbacks(owned_processes, subsystems)

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
            gpu_processes=gpu_processes,
            owned_processes=owned_processes,
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

        if subsystem == "stt" and gpu.vram_total_mb <= STT_GPU_CPU_DEFAULT_CUTOFF_MB:
            return False

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
