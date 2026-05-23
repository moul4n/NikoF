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

export interface LLMSidecarStatus {
  state: string;
  profile_id: string;
  family: string | null;
  configured: boolean;
  available: boolean;
  loaded: boolean;
  model_name: string | null;
  endpoint: string | null;
  timeout_seconds: number | null;
  last_error: string | null;
  requests_processed: number;
  average_latency_ms: number | null;
  last_request_epoch: number | null;
  vram_allocated_mb: number | null;
  ram_allocated_mb: number | null;
  process_managed: boolean;
  process_running: boolean;
  process_healthy: boolean;
  started_by_backend: boolean;
  owner_pid: number | null;
  health_url: string | null;
  startup_timeout_seconds: number | null;
  stdout_log_path: string | null;
  stderr_log_path: string | null;
}

export type LlmControlAction = "start" | "restart" | "warmup" | "stop";

export interface LlmControlResult {
  schema_version: number;
  action: LlmControlAction;
  llm: LLMSidecarStatus & { schema_version?: number };
  warmup?: {
    profile_id: string;
    status: string;
    text: string;
    locale: string;
  };
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
  llm_sidecar: LLMSidecarStatus;
  tts_worker: TTSWorkerStatus;
  warnings: string[];
}

export interface ResourceMonitorState {
  status: "loading" | "ready" | "error";
  snapshot: ResourceStatusSnapshot | null;
  error: string | null;
  llmAction: LlmControlAction | null;
  llmActionError: string | null;
  llmLastResult: LlmControlResult | null;
  sendLlmControl(action: LlmControlAction): Promise<void>;
}

const POLL_INTERVAL_MS = 10000;

function resolveApiBaseUrl(): string {
  const configured = (import.meta as any).env?.VITE_BACKEND_API_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  return "/api";
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

export function useResourceMonitor(): ResourceMonitorState {
  const [state, setState] = useState<ResourceMonitorState>({
    status: "loading",
    snapshot: null,
    error: null,
    llmAction: null,
    llmActionError: null,
    llmLastResult: null,
    sendLlmControl: async () => {
      throw new Error("Resource monitor is still initializing.");
    },
  });

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;
    const baseUrl = resolveApiBaseUrl();

    async function fetchSnapshot(): Promise<ResourceStatusSnapshot> {
      const response = await fetch(`${baseUrl}/system/resources`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    }

    async function poll() {
      try {
        const data = await fetchSnapshot();
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            status: "ready",
            snapshot: data,
            error: null,
          }));
        }
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            status: prev.snapshot ? "ready" : "error",
            snapshot: prev.snapshot,
            error: normalizeErrorMessage(err),
            llmAction: prev.llmAction,
            llmActionError: prev.llmActionError,
            llmLastResult: prev.llmLastResult,
            sendLlmControl: prev.sendLlmControl,
          }));
        }
      }

      if (!cancelled) {
        timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    async function sendLlmControl(action: LlmControlAction): Promise<void> {
      setState((previous) => ({
        ...previous,
        llmAction: action,
        llmActionError: null,
      }));

      try {
        const response = await fetch(`${baseUrl}/session/llm/control`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action }),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const result: LlmControlResult = await response.json();
        const refreshedSnapshot = await fetchSnapshot();
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            status: "ready",
            snapshot: refreshedSnapshot,
            error: null,
            llmAction: null,
            llmActionError: null,
            llmLastResult: result,
          }));
        }
      } catch (error) {
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            llmAction: null,
            llmActionError: normalizeErrorMessage(error),
          }));
        }
      }
    }

    setState((previous) => ({
      ...previous,
      sendLlmControl,
    }));

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
