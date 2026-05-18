import React from "react";
import {
  resolveBackendHealthSummary,
  resolveRuntimeLaneSummaries,
  resolveVisibleRuntimeLaneSummary
} from "./controlSurfaceSummary.js";
import type {
  BackendHealthPayloadDocument,
  CharacterCatalogEntry
} from "../shared/types/character.js";

interface ControlSurfaceSummaryPanelProps {
  selectedCharacter: CharacterCatalogEntry | null;
  backendStatusMessage: string;
  sessionId: string | null;
  healthPayload: BackendHealthPayloadDocument | null;
  speechDeliveryLabel: string;
  speechPlaybackStatusLabel: string;
  speechPlaybackTransportLabel: string;
  speechPlaybackMessage: string | null;
  speechLifecycleNextCursor: string | null;
}

export function ControlSurfaceSummaryPanel({
  selectedCharacter,
  backendStatusMessage,
  sessionId,
  healthPayload,
  speechDeliveryLabel,
  speechPlaybackStatusLabel,
  speechPlaybackTransportLabel,
  speechPlaybackMessage,
  speechLifecycleNextCursor
}: ControlSurfaceSummaryPanelProps): JSX.Element {
  const runtimeLaneSummaries = resolveRuntimeLaneSummaries(healthPayload);
  const backendHealthSummary = resolveBackendHealthSummary(runtimeLaneSummaries);
  const visiblePrerequisiteSummary = resolveVisibleRuntimeLaneSummary(runtimeLaneSummaries);

  return (
    <section className="surface-panel" aria-labelledby="control-surface-summary-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Control surface</p>
          <h2 id="control-surface-summary-title">Configuration and session status</h2>
        </div>
      </div>

      <p className="surface-panel__message">{backendStatusMessage}</p>

      <dl className="surface-panel__facts">
        <div>
          <dt>Current surface</dt>
          <dd>Control shell</dd>
        </div>
        <div>
          <dt>Selected character</dt>
          <dd>{selectedCharacter?.summary.displayName ?? "No manifest-backed character selected"}</dd>
        </div>
        <div>
          <dt>Backend session</dt>
          <dd>{sessionId ?? "No backend session id available"}</dd>
        </div>
        <div>
          <dt>Speech delivery</dt>
          <dd>{speechDeliveryLabel}</dd>
        </div>
        <div>
          <dt>Playback bridge</dt>
          <dd>{speechPlaybackStatusLabel}</dd>
        </div>
        <div>
          <dt>Playback transport</dt>
          <dd>{speechPlaybackTransportLabel}</dd>
        </div>
        {runtimeLaneSummaries.map((lane) => (
          <div key={lane.id}>
            <dt>{lane.label}</dt>
            <dd>{lane.statusLabel}</dd>
          </div>
        ))}
      </dl>

      <p className="surface-panel__summary">
        The control surface keeps catalog selection, backend-confirmed active-character state, and speech lifecycle status in one shell while the display surface stays presentation-only.
      </p>
      {backendHealthSummary ? <p className="surface-panel__summary">{backendHealthSummary}</p> : null}
      {visiblePrerequisiteSummary ? <p className="surface-panel__summary">{visiblePrerequisiteSummary}</p> : null}
      {speechPlaybackMessage ? <p className="surface-panel__summary">{speechPlaybackMessage}</p> : null}
      {speechLifecycleNextCursor ? (
        <p className="surface-panel__summary">
          Current speech lifecycle cursor: {speechLifecycleNextCursor}.
        </p>
      ) : null}
    </section>
  );
}