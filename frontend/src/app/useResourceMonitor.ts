import { useEffect, useState } from "react";

export interface GpuStatus {
  device_index: number;
  device_name: string;
  vram_total_mb: number;
  vram_used_mb: number;
  vram_free_mb: number;
  utilization_percent: number | null;
}

export interface SystemMemoryStatus {
  ram_total_mb: number;
  ram_used_mb: number;
  ram_available_mb: number;
  ram_percent: number;
}

export interface SubsystemStatus {
  subsystem: string;
  loaded: boolean;
  model_name: string | null;
  vram_allocated_mb: number | null;
  ram_allocated_mb: number | null;
  last_request_epoch: number | null;
  requests_processed: number;
  average_latency_ms: number | null;
}

export interface TTSWorkerStatus {
  state: string;
  model_name: string | null;
  queue_depth: number;
  max_queue_depth: number;
  total_processed: number;
  average_latency_ms: number | null;
  last_error: string | null;
  vram_allocated_mb: number | null;
}

export interface GpuProcessStatus {
  pid: number;
  process_name: string;
  used_memory_mb: number | null;
  gpu_uuid: string | null;
}

export interface OwnedProcessStatus {
  pid: number;
  parent_pid: number | null;
  label: string;
  process_name: string;
  executable: string | null;
  command: string | null;
  status: string | null;
  rss_mb: number | null;
  gpu_memory_mb: number | null;
}

export interface ResourceStatusSnapshot {
  schema_version: number;
  timestamp_epoch: number;
  gpu: GpuStatus | null;
  gpu_processes: GpuProcessStatus[];
  owned_processes: OwnedProcessStatus[];
  system_memory: SystemMemoryStatus;
  subsystems: SubsystemStatus[];
  tts_worker: TTSWorkerStatus;
  warnings: string[];
}

export interface ResourceMonitorState {
  status: "loading" | "ready" | "error";
  snapshot: ResourceStatusSnapshot | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 10000;

function resolveApiBaseUrl(): string {
  const configured = (import.meta as any).env?.VITE_BACKEND_API_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  return "/api";
}

export function useResourceMonitor(): ResourceMonitorState {
  const [state, setState] = useState<ResourceMonitorState>({
    status: "loading",
    snapshot: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    async function poll() {
      try {
        const baseUrl = resolveApiBaseUrl();
        const response = await fetch(`${baseUrl}/system/resources`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data: ResourceStatusSnapshot = await response.json();
        if (!cancelled) {
          setState({ status: "ready", snapshot: data, error: null });
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            status: prev.snapshot ? "ready" : "error",
            snapshot: prev.snapshot,
            error: err instanceof Error ? err.message : "Unknown error",
          }));
        }
      }

      if (!cancelled) {
        timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  return state;
}
