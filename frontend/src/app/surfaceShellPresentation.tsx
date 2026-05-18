import React from "react";
import { AvatarStage } from "../avatar/components/AvatarStage";
import {
  SurfaceModeSwitch,
  buildSurfaceHref,
  resolveSpeechPlaybackStatusLabel,
  resolveSpeechPlaybackTransportLabel
} from "./ControlSurfaceShell";
import type {
  AvatarAnimationPlaybackPath,
  AvatarDebugProfileView,
  AvatarRuntimeBridge
} from "../avatar/runtime/avatarRuntime";
import {
  describeSpeechLifecycleStateMessage,
  resolveSpeechLifecycleDeliveryLabel,
  type SpeechLifecycleLoadState
} from "./useSpeechLifecycleState";
import type { SpeechPlaybackState } from "./useSpeechPlaybackBridge";
import type { SessionAnimationLoadState } from "./useSessionAnimationState";
import {
  DevAnimationSwitcherPanel,
  DevDisplayPlaybackPathPanel,
  DevDisplayProfilePanel,
  DevDisplayRenderModePanel,
  type DevDisplayAnimationOptionId,
  type DevDisplayAnimationOverrideState
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
  sessionAnimationState: SessionAnimationLoadState;
  isDevAnimationSwitcherEnabled: boolean;
  devDisplayProfileView: AvatarDebugProfileView;
  onSelectDevDisplayProfileView: (profileView: AvatarDebugProfileView) => void;
  devDisplayRigOverlayEnabled: boolean;
  onSetDevDisplayRigOverlayEnabled: (enabled: boolean) => void;
  devDisplayAnimationOverride: DevDisplayAnimationOverrideState;
  onSelectDevDisplayAnimation: (optionId: DevDisplayAnimationOptionId) => void;
  isDisplayRuntimeReady: boolean;
  devDisplayPlaybackPath: AvatarAnimationPlaybackPath;
  onSelectDevDisplayPlaybackPath: (playbackPath: AvatarAnimationPlaybackPath) => void;
}

export function DisplaySurfaceShell({
  runtime,
  selectedCharacter,
  backendStatusMessage,
  speechLifecycleState,
  speechPlaybackStatus,
  sessionAnimationState,
  isDevAnimationSwitcherEnabled,
  devDisplayProfileView,
  onSelectDevDisplayProfileView,
  devDisplayRigOverlayEnabled,
  onSetDevDisplayRigOverlayEnabled,
  devDisplayAnimationOverride,
  onSelectDevDisplayAnimation,
  isDisplayRuntimeReady,
  devDisplayPlaybackPath,
  onSelectDevDisplayPlaybackPath
}: DisplaySurfaceShellProps): JSX.Element {
  const speechLifecycleSnapshot = speechLifecycleState.snapshot;
  const speechLifecycleMessage = describeSpeechLifecycleStateMessage(speechLifecycleState);
  const displayReplySnapshot = resolveDisplayReplySnapshot(speechLifecycleSnapshot);
  const controlSurfaceHref = buildSurfaceHref("control");
  const displaySurfaceHref = buildSurfaceHref("display");
  const backendAnimationId = sessionAnimationState.snapshot?.semanticCommand.id ?? null;

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
        <AvatarStage runtime={runtime} selectedCharacter={selectedCharacter} variant="display" />
        <aside className="app-shell__display-rail">
          {isDevAnimationSwitcherEnabled ? (
            <>
              <DevDisplayProfilePanel
                selectedProfileView={devDisplayProfileView}
                onSelectProfileView={onSelectDevDisplayProfileView}
              />
              <DevDisplayRenderModePanel
                rigOverlayEnabled={devDisplayRigOverlayEnabled}
                controlsEnabled={isDisplayRuntimeReady}
                onSetRigOverlayEnabled={onSetDevDisplayRigOverlayEnabled}
              />
              <DevAnimationSwitcherPanel
                selectedOptionId={devDisplayAnimationOverride.optionId}
                backendAnimationId={backendAnimationId}
                controlsEnabled={isDisplayRuntimeReady}
                onSelectOption={onSelectDevDisplayAnimation}
              />
              <DevDisplayPlaybackPathPanel
                selectedPlaybackPath={devDisplayPlaybackPath}
                onSelectPlaybackPath={onSelectDevDisplayPlaybackPath}
              />
            </>
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