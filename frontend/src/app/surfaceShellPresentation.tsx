import React, { useEffect, useState } from "react";
import { AvatarStage } from "../avatar/components/AvatarStage";
import { DisplayPushToTalkControl } from "./DisplayPushToTalkControl";
import {
  SurfaceModeSwitch,
  buildSurfaceHref,
  resolveSpeechPlaybackStatusLabel,
  resolveSpeechPlaybackTransportLabel
} from "./ControlSurfaceShell";
import type {
  AvatarRuntimeBridge
} from "../avatar/runtime/avatarRuntime";
import {
  describeSpeechLifecycleStateMessage,
  resolveSpeechLifecycleDeliveryLabel,
  type SpeechLifecycleLoadState
} from "./useSpeechLifecycleState";
import { useAttentionState } from "./useAttentionState";
import { useAttentionCapture } from "../features/vision/useAttentionCapture.js";
import type { SpeechPlaybackState } from "./useSpeechPlaybackBridge";
import {
  DevDisplayRenderModePanel,
  type DevDisplayAnimationOptionId
} from "./devDisplayTools";
import type {
  BackendSpeechSynthesisDocument,
  BackendSpeechTranscriptionDocument,
  CharacterCatalogEntry
} from "../shared/types/character";

type SpeechLifecycleSnapshot = SpeechLifecycleLoadState["snapshot"];

export function resolveDisplayReplySnapshot(snapshot: SpeechLifecycleSnapshot): {
  label: string | null;
  status: string | null;
  text: string | null;
} {
  const assistantEvent = snapshot?.canonicalAssistantMessageEvent;
  const assistantText = assistantEvent?.assistant?.text?.trim();

  if (assistantText) {
    return {
      label: "Assistant reply",
      status: assistantEvent?.assistant?.status ?? assistantEvent?.status ?? null,
      text: assistantText
    };
  }

  const replyEvent = snapshot?.canonicalSpeechSynthesisEvent;

  if (!replyEvent) {
    return {
      label: null,
      status: null,
      text: null
    };
  }

  const synthesisText = replyEvent.synthesis?.text?.trim();

  if (synthesisText) {
    return {
      label: "Synthesis reply",
      status: replyEvent.synthesis?.status ?? replyEvent.status,
      text: synthesisText
    };
  }

  return {
    label: "Reply activity",
    status: replyEvent.assistant?.status ?? replyEvent.synthesis?.status ?? replyEvent.status,
    text: null
  };
}


interface DisplaySurfaceStatusPanelProps {
  selectedCharacter: CharacterCatalogEntry | null;
  backendStatusMessage: string;
  speechLifecycleState: SpeechLifecycleLoadState;
  speechLifecycleSnapshot: SpeechLifecycleSnapshot;
  speechLifecycleMessage: string | null;
  replyActivityLabel: string | null;
  replyActivityStatus: string | null;
  replyActivityText: string | null;
  speechPlaybackStatus: SpeechPlaybackState;
}

export function DisplaySurfaceStatusPanel({
  selectedCharacter,
  backendStatusMessage,
  speechLifecycleState,
  speechLifecycleSnapshot,
  speechLifecycleMessage,
  replyActivityLabel,
  replyActivityStatus,
  replyActivityText,
  speechPlaybackStatus
}: DisplaySurfaceStatusPanelProps): JSX.Element {
  const speechPlaybackStatusLabel = resolveSpeechPlaybackStatusLabel(speechPlaybackStatus);

  return (
    <section className="surface-panel surface-panel--display" aria-labelledby="display-surface-status-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Display surface</p>
          <h2 id="display-surface-status-title">Render status</h2>
        </div>
      </div>

      <dl className="surface-panel__facts">
        <div>
          <dt>Character</dt>
          <dd>{selectedCharacter?.summary.displayName ?? "Waiting for a manifest-backed selection"}</dd>
        </div>
        <div>
          <dt>Speech delivery</dt>
          <dd>{resolveSpeechLifecycleDeliveryLabel(speechLifecycleState)}</dd>
        </div>
        <div>
          <dt>Backend session</dt>
          <dd>{speechLifecycleSnapshot?.sessionId ?? "Session unavailable"}</dd>
        </div>
        <div>
          <dt>Event count</dt>
          <dd>{speechLifecycleSnapshot ? speechLifecycleSnapshot.eventCount : 0}</dd>
        </div>
        <div>
          <dt>Playback bridge</dt>
          <dd>{speechPlaybackStatusLabel}</dd>
        </div>
        <div>
          <dt>Playback transport</dt>
          <dd>{resolveSpeechPlaybackTransportLabel(speechPlaybackStatus)}</dd>
        </div>
      </dl>

      <p className="surface-panel__message">{backendStatusMessage}</p>
      {speechLifecycleMessage ? <p className="surface-panel__summary">{speechLifecycleMessage}</p> : null}
      {speechPlaybackStatus.playbackKey ? <p className="surface-panel__summary">{speechPlaybackStatus.message}</p> : null}
      {replyActivityText ? (
        <>
          <p className="surface-panel__summary">
            {replyActivityLabel}
            {replyActivityStatus ? ` · ${replyActivityStatus}` : ""}
          </p>
          <p className="surface-panel__message">{replyActivityText}</p>
        </>
      ) : replyActivityLabel ? (
        <p className="surface-panel__summary">
          {replyActivityLabel}
          {replyActivityStatus ? ` detected (${replyActivityStatus}).` : " detected on the backend-owned speech lifecycle stream."}
        </p>
      ) : null}
    </section>
  );
}

interface DisplaySurfaceShellProps {
  runtime: AvatarRuntimeBridge;
  selectedCharacter: CharacterCatalogEntry | null;
  backendStatusMessage: string;
  speechLifecycleState: SpeechLifecycleLoadState;
  speechPlaybackStatus: SpeechPlaybackState;
  isDevAnimationSwitcherEnabled: boolean;
  devDisplayRigOverlayEnabled: boolean;
  onSetDevDisplayRigOverlayEnabled: (enabled: boolean) => void;
  captionsEnabled: boolean;
  onSetCaptionsEnabled: (enabled: boolean) => void;
  onAppearanceControlChange: (id: string, value: number) => void;
  onAppearanceReset: () => void;
  onSelectDevDisplayAnimation: (optionId: DevDisplayAnimationOptionId) => void;
  isDisplayRuntimeReady: boolean;
}

export function DisplaySurfaceShell({
  runtime,
  selectedCharacter,
  backendStatusMessage,
  speechLifecycleState,
  speechPlaybackStatus,
  isDevAnimationSwitcherEnabled,
  devDisplayRigOverlayEnabled,
  onSetDevDisplayRigOverlayEnabled,
  captionsEnabled,
  onSetCaptionsEnabled,
  onAppearanceControlChange,
  onAppearanceReset,
  onSelectDevDisplayAnimation,
  isDisplayRuntimeReady
}: DisplaySurfaceShellProps): JSX.Element {
  const attentionState = useAttentionState();
  const speechLifecycleSnapshot = speechLifecycleState.snapshot;
  const speechLifecycleMessage = describeSpeechLifecycleStateMessage(speechLifecycleState);
  const displayReplySnapshot = resolveDisplayReplySnapshot(speechLifecycleSnapshot);
  const controlSurfaceHref = buildSurfaceHref("control");
  const displaySurfaceHref = buildSurfaceHref("display");

  // Run the browser webcam capture here too, so attention tracking keeps working
  // on the display surface (not just while the control panel is mounted). It is
  // driven entirely by the backend attention snapshot, whose enabled/tracking/
  // device come from the control-surface settings (persisted + reconciled).
  const attentionSnapshot = attentionState.state.snapshot;
  useAttentionCapture({
    enabled: attentionSnapshot?.enabled ?? false,
    tracking: attentionSnapshot?.tracking ?? false,
    selectedDeviceId: attentionSnapshot?.selected_device_id ?? null,
    selectedDeviceLabel: attentionSnapshot?.selected_device_label ?? null,
  });

  // Voice captions (subtitles for the live transcript + the assistant reply).
  // The on/off state is a backend-driven display setting (toggled here or from
  // the control surface, persisted across restarts) — see useDisplaySettings.
  // Captions overlay rendered over the bottom of the avatar viewport (the
  // assistant's reply as the primary subtitle, the live transcript beneath it).
  const captionsNode = captionsEnabled ? (
    <div className="app-shell__captions" aria-live="polite">
      {displayReplySnapshot.text ? (
        <p className="app-shell__live-caption app-shell__live-caption--assistant" data-testid="assistant-caption">
          {displayReplySnapshot.text}
        </p>
      ) : null}
      {speechLifecycleSnapshot?.livePartialTranscript ? (
        <p
          className="app-shell__live-caption app-shell__live-caption--user"
          role="status"
          data-testid="live-caption"
        >
          {speechLifecycleSnapshot.livePartialTranscript}
        </p>
      ) : null}
    </div>
  ) : null;

  useEffect(() => {
    runtime.setAttentionDebugMarkerEnabled(attentionState.state.showTrackingDebugMarker);
  }, [attentionState.state.showTrackingDebugMarker, runtime]);

  useEffect(() => {
    const attentionSnapshot = attentionState.state.snapshot;

    if (
      attentionState.state.status !== "ready" ||
      !attentionSnapshot?.enabled ||
      !attentionSnapshot.tracking ||
      !attentionSnapshot.subject
    ) {
      runtime.setAttentionTarget(null);
      return;
    }

    runtime.setAttentionTarget({
      normalizedX: attentionSnapshot.subject.normalized_x,
      normalizedY: attentionSnapshot.subject.normalized_y,
      confidence: attentionSnapshot.confidence ?? null,
    });

    return () => {
      runtime.setAttentionTarget(null);
    };
  }, [attentionState.state.snapshot, attentionState.state.status, runtime]);

  return (
    <div className="app-shell app-shell--display">
      <header className="app-shell__header app-shell__header--display">
        <div className="app-shell__display-toolbar">
          <div>
            <p className="eyebrow">Display entrypoint</p>
            <h1>NikoF avatar display surface</h1>
          </div>
          <SurfaceModeSwitch
            surfaceMode="display"
            controlSurfaceHref={controlSurfaceHref}
            displaySurfaceHref={displaySurfaceHref}
          />
        </div>
        <p className="app-shell__summary app-shell__summary--display">
          Launch this window directly at `/display` for presentation mode. The shared App still owns catalog load, backend-confirmed active-character reconciliation, and live `speech.lifecycle` state.
        </p>
      </header>

      <main className="app-shell__display">
        <div className="app-shell__display-stage">
          <AvatarStage
            runtime={runtime}
            selectedCharacter={selectedCharacter}
            variant="display"
            onSelectDisplayAnimationOverride={onSelectDevDisplayAnimation}
            captionsSlot={captionsNode}
            onAppearanceControlChange={onAppearanceControlChange}
            onAppearanceReset={onAppearanceReset}
          />
        </div>
        <aside className="app-shell__display-rail">
          <DisplayPushToTalkControl />
          <button
            type="button"
            className="app-shell__caption-toggle"
            aria-pressed={captionsEnabled}
            onClick={() => onSetCaptionsEnabled(!captionsEnabled)}
          >
            {captionsEnabled ? "Captions: On" : "Captions: Off"}
          </button>
          {isDevAnimationSwitcherEnabled ? (
            <DevDisplayRenderModePanel
              rigOverlayEnabled={devDisplayRigOverlayEnabled}
              controlsEnabled={isDisplayRuntimeReady}
              onSetRigOverlayEnabled={onSetDevDisplayRigOverlayEnabled}
            />
          ) : null}
          <DisplaySurfaceStatusPanel
            selectedCharacter={selectedCharacter}
            backendStatusMessage={backendStatusMessage}
            speechLifecycleState={speechLifecycleState}
            speechLifecycleSnapshot={speechLifecycleSnapshot}
            speechLifecycleMessage={speechLifecycleMessage}
            replyActivityLabel={displayReplySnapshot.label}
            replyActivityStatus={displayReplySnapshot.status}
            replyActivityText={displayReplySnapshot.text}
            speechPlaybackStatus={speechPlaybackStatus}
          />
        </aside>
      </main>
    </div>
  );
}

export { ControlSurfaceShell } from "./ControlSurfaceShell";