import React from "react";
import type { SpeechPlaybackState } from "./useSpeechPlaybackBridge";
import {
  describeBackendCanonicalBundleReadiness,
  renderSpeechBundleTimeline
} from "./ControlSurfaceOperatorCommandPanel.js";

interface ControlSurfaceSpeechPlaybackPanelProps {
  speechPlaybackStatus: SpeechPlaybackState;
}

/**
 * Read-only speech playback diagnostics. This is control output, not an edit
 * surface, so it lives on the Other / Advanced tab rather than cluttering the
 * compact LLM / TTS command forms. Shows the last canonical bundle's playback
 * source, replay control, readiness, and lip-sync cue timeline.
 */
export function ControlSurfaceSpeechPlaybackPanel({
  speechPlaybackStatus
}: ControlSurfaceSpeechPlaybackPanelProps): JSX.Element {
  const bundle = speechPlaybackStatus.lastBundle;
  const canReplayLastBundle =
    bundle !== null &&
    (bundle.audioSource !== null ||
      (typeof bundle.utteranceDurationMs === "number" && bundle.utteranceDurationMs > 0));
  const readiness = describeBackendCanonicalBundleReadiness(speechPlaybackStatus);

  return (
    <section className="surface-panel" aria-labelledby="speech-playback-panel-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Speech playback</p>
          <h2 id="speech-playback-panel-title">Pipeline diagnostics</h2>
        </div>
      </div>

      {speechPlaybackStatus.playbackKey ? (
        <p className="surface-panel__summary">{speechPlaybackStatus.message}</p>
      ) : null}
      {speechPlaybackStatus.audioReference ? (
        <p className="surface-panel__summary">
          Playback source: {speechPlaybackStatus.audioSource ?? speechPlaybackStatus.audioReference}
        </p>
      ) : null}
      {speechPlaybackStatus.error ? (
        <p className="surface-panel__summary">Playback note: {speechPlaybackStatus.error}</p>
      ) : null}

      {bundle ? (
        <div className="operator-panel__actions">
          <button
            className="operator-panel__button"
            type="button"
            onClick={() => speechPlaybackStatus.replayLastBundle()}
            disabled={!canReplayLastBundle}
          >
            Replay last backend canonical bundle
          </button>
        </div>
      ) : null}
      {bundle ? (
        <p className="surface-panel__summary">
          Backend canonical bundle · default track {speechPlaybackStatus.lipSyncDefaultTrackId ?? "none"} · tracks {speechPlaybackStatus.lipSyncTrackIds.join(", ") || "none"} · source {speechPlaybackStatus.lipSyncTimingSource ?? "unspecified"}
          {speechPlaybackStatus.lipSyncSourceSlotType ? ` / ${speechPlaybackStatus.lipSyncSourceSlotType}` : ""}
        </p>
      ) : null}
      {readiness ? <p className="surface-panel__summary">{readiness}</p> : null}
      {renderSpeechBundleTimeline(speechPlaybackStatus)}

      {!speechPlaybackStatus.playbackKey && !bundle && !speechPlaybackStatus.audioReference ? (
        <p className="surface-panel__summary">No speech playback bundle has been published yet.</p>
      ) : null}
    </section>
  );
}
