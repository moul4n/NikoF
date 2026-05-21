import React from "react";
import type {
  GpuProcessStatus,
  OwnedProcessStatus,
  ResourceMonitorState,
  ResourceStatusSnapshot,
} from "./useResourceMonitor";

function formatMb(mb: number | null | undefined): string {
  if (mb == null) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value.toFixed(0)}%`;
}

function VramBar({ used, total }: { used: number; total: number }): JSX.Element {
  const percent = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const isWarning = percent >= 85;
  return (
    <div className="resource-bar" title={`${formatMb(used)} / ${formatMb(total)}`}>
      <div
        className={`resource-bar__fill ${isWarning ? "resource-bar__fill--warning" : ""}`}
        style={{ width: `${percent}%` }}
      />
      <span className="resource-bar__label">{percent.toFixed(0)}%</span>
    </div>
  );
}

function RamBar({ used, total }: { used: number; total: number }): JSX.Element {
  const percent = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const isWarning = percent >= 90;
  return (
    <div className="resource-bar" title={`${formatMb(used)} / ${formatMb(total)}`}>
      <div
        className={`resource-bar__fill ${isWarning ? "resource-bar__fill--warning" : ""}`}
        style={{ width: `${percent}%` }}
      />
      <span className="resource-bar__label">{percent.toFixed(0)}%</span>
    </div>
  );
}

function TTSWorkerSection({ snapshot }: { snapshot: ResourceStatusSnapshot }): JSX.Element {
  const tts = snapshot.tts_worker;
  const stateColor = tts.state === "ready" || tts.state === "processing"
    ? "resource-status--ok"
    : tts.state === "error"
    ? "resource-status--error"
    : "resource-status--idle";

  return (
    <div className="resource-panel__section">
      <h4>TTS Worker</h4>
      <dl className="resource-panel__grid">
        <dt>State</dt>
        <dd className={stateColor}>{tts.state}</dd>
        <dt>Model</dt>
        <dd>{tts.model_name ?? "not loaded"}</dd>
        <dt>Queue</dt>
        <dd>{tts.queue_depth} / {tts.max_queue_depth}</dd>
        <dt>Processed</dt>
        <dd>{tts.total_processed}</dd>
        <dt>Avg latency</dt>
        <dd>{formatLatency(tts.average_latency_ms)}</dd>
        <dt>VRAM</dt>
        <dd>{formatMb(tts.vram_allocated_mb)}</dd>
        {tts.last_error ? (
          <>
            <dt>Last error</dt>
            <dd className="resource-status--error">{tts.last_error}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function SubsystemsSection({ snapshot }: { snapshot: ResourceStatusSnapshot }): JSX.Element {
  return (
    <div className="resource-panel__section">
      <h4>Model subsystems</h4>
      <div className="resource-panel__table-wrap">
        <table className="resource-panel__table">
          <thead>
            <tr>
              <th>Subsystem</th>
              <th>Status</th>
              <th>Model</th>
              <th>VRAM</th>
              <th>Requests</th>
              <th>Avg latency</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.subsystems.map((s) => (
              <tr key={s.subsystem}>
                <td>{s.subsystem.toUpperCase()}</td>
                <td className={s.loaded ? "resource-status--ok" : "resource-status--idle"}>
                  {s.loaded ? "loaded" : "idle"}
                </td>
                <td>{s.model_name ?? "—"}</td>
                <td>{formatMb(s.vram_allocated_mb)}</td>
                <td>{s.requests_processed}</td>
                <td>{formatLatency(s.average_latency_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatCommand(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 96 ? `${value.slice(0, 93)}...` : value;
}

function formatProcessLabel(label: string): string {
  switch (label) {
    case "backend":
      return "Backend API";
    case "backend-worker":
      return "Backend worker";
    case "backend-child":
      return "Backend child";
    case "tts-sidecar":
      return "TTS sidecar";
    case "tts-entrypoint":
      return "TTS entrypoint";
    case "llm-sidecar":
      return "LLM sidecar";
    case "stt-sidecar":
      return "STT sidecar";
    default:
      return label;
  }
}

function OwnedProcessesSection({ processes }: { processes: OwnedProcessStatus[] }): JSX.Element {
  return (
    <div className="resource-panel__section">
      <h4>Backend-owned processes</h4>
      {processes.length === 0 ? (
        <p className="resource-panel__metric">No backend-owned child processes detected</p>
      ) : (
        <div className="resource-panel__table-wrap">
          <table className="resource-panel__table">
            <thead>
              <tr>
                <th>Role</th>
                <th>PID</th>
                <th>Process</th>
                <th>RAM</th>
                <th>GPU VRAM</th>
                <th>Command</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((process) => (
                <tr key={process.pid}>
                  <td>{formatProcessLabel(process.label)}</td>
                  <td>{process.pid}</td>
                  <td>{process.process_name}</td>
                  <td>{formatMb(process.rss_mb)}</td>
                  <td>{formatMb(process.gpu_memory_mb)}</td>
                  <td className="resource-panel__command" title={process.command ?? undefined}>
                    {formatCommand(process.command)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GpuProcessesSection({ processes }: { processes: GpuProcessStatus[] }): JSX.Element {
  return (
    <div className="resource-panel__section">
      <h4>Visible GPU processes</h4>
      {processes.length === 0 ? (
        <p className="resource-panel__metric">No GPU process details available</p>
      ) : (
        <div className="resource-panel__table-wrap">
          <table className="resource-panel__table">
            <thead>
              <tr>
                <th>PID</th>
                <th>Process</th>
                <th>GPU VRAM</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((process) => (
                <tr key={`${process.pid}-${process.process_name}`}>
                  <td>{process.pid}</td>
                  <td className="resource-panel__command" title={process.process_name}>{process.process_name}</td>
                  <td>{formatMb(process.used_memory_mb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface ResourceMonitorPanelProps {
  resourceState: ResourceMonitorState;
}

export function ResourceMonitorPanel({ resourceState }: ResourceMonitorPanelProps): JSX.Element {
  const { status, snapshot, error } = resourceState;

  return (
    <section className="resource-panel" aria-labelledby="resource-panel-title">
      <div className="resource-panel__header">
        <div>
          <p className="eyebrow">System resources</p>
          <h2 id="resource-panel-title">Resource monitor</h2>
        </div>
        <span className={`resource-panel__status resource-panel__status--${status}`}>
          {status === "loading" ? "connecting..." : status === "error" ? "offline" : "live"}
        </span>
      </div>

      {status === "error" && !snapshot ? (
        <p className="resource-panel__message resource-panel__message--error">
          Cannot reach resource monitor: {error}
        </p>
      ) : null}

      {snapshot ? (
        <>
          {snapshot.warnings.length > 0 ? (
            <div className="resource-panel__warnings">
              {snapshot.warnings.map((w, i) => (
                <p key={i} className="resource-panel__warning">{w}</p>
              ))}
            </div>
          ) : null}

          {snapshot.gpu ? (
            <div className="resource-panel__section">
              <h4>GPU: {snapshot.gpu.device_name}</h4>
              <div className="resource-panel__bar-row">
                <span>VRAM</span>
                <VramBar used={snapshot.gpu.vram_used_mb} total={snapshot.gpu.vram_total_mb} />
                <span className="resource-panel__bar-detail">
                  {formatMb(snapshot.gpu.vram_used_mb)} / {formatMb(snapshot.gpu.vram_total_mb)}
                </span>
              </div>
              {snapshot.gpu.utilization_percent != null ? (
                <p className="resource-panel__metric">GPU utilization: {formatPercent(snapshot.gpu.utilization_percent)}</p>
              ) : null}
            </div>
          ) : (
            <div className="resource-panel__section">
              <h4>GPU</h4>
              <p className="resource-panel__metric">No GPU detected or torch not available</p>
            </div>
          )}

          <div className="resource-panel__section">
            <h4>System RAM</h4>
            <div className="resource-panel__bar-row">
              <span>RAM</span>
              <RamBar used={snapshot.system_memory.ram_used_mb} total={snapshot.system_memory.ram_total_mb} />
              <span className="resource-panel__bar-detail">
                {formatMb(snapshot.system_memory.ram_used_mb)} / {formatMb(snapshot.system_memory.ram_total_mb)}
              </span>
            </div>
          </div>

          <TTSWorkerSection snapshot={snapshot} />
          <SubsystemsSection snapshot={snapshot} />
          <OwnedProcessesSection processes={snapshot.owned_processes} />
          <GpuProcessesSection processes={snapshot.gpu_processes} />
        </>
      ) : null}
    </section>
  );
}
