import React, { useState } from "react";
import { CharacterCatalogPanel } from "../avatar/components/CharacterCatalogPanel.js";
import { ControlSurfaceSummaryPanel } from "./ControlSurfaceSummaryPanel.js";
import { ControlSurfaceTtsSettingsPanel } from "./ControlSurfaceTtsSettingsPanel.js";
import { ControlSurfaceCharacterProfilePanel } from "./ControlSurfaceCharacterProfilePanel.js";
import { ResourceMonitorPanel } from "./ResourceMonitorPanel.js";
import { useResourceMonitor } from "./useResourceMonitor.js";
import type {
  BackendOperatorCommandResponseDocument,
  BackendSpeechSynthesisDocument,
  BackendSpeechTranscriptionDocument,
  CharacterCatalogEntry,
  CharacterId
} from "../shared/types/character";
import type { BackendSyncState, CatalogLoadState } from "./useCharacterShellState";
import {
  describeSpeechLifecycleStateMessage,
  resolveSpeechLifecycleCharacterId,
  resolveSpeechLifecycleDeliveryLabel,
  type SpeechLifecycleLoadState
} from "./useSpeechLifecycleState.js";
import type { SpeechPlaybackState } from "./useSpeechPlaybackBridge";
import { ControlSurfaceOperatorCommandPanel } from "./ControlSurfaceOperatorCommandPanel.js";
import { ControlSurfaceGesturePanel } from "./ControlSurfaceGesturePanel.js";
import { ControlSurfaceBackgroundPanel } from "./ControlSurfaceBackgroundPanel.js";
import { ControlSurfaceDisplayPanel } from "./ControlSurfaceDisplayPanel.js";
import { ControlSurfaceAttentionPanel } from "./ControlSurfaceAttentionPanel.js";
import { ControlSurfaceAudioOutputPanel } from "./ControlSurfaceAudioOutputPanel.js";
import { ControlSurfaceSttPanel } from "./ControlSurfaceSttPanel.js";
import { ControlSurfaceSpeechPlaybackPanel } from "./ControlSurfaceSpeechPlaybackPanel.js";
import { ControlSurfaceKokoroVoicePanel } from "./ControlSurfaceKokoroVoicePanel.js";
import type { UseDisplaySettingsResult } from "./useDisplaySettings";

type SpeechLifecycleSnapshot = SpeechLifecycleLoadState["snapshot"];

function formatDurationLabel(durationMs: number | null | undefined): string {
  if (typeof durationMs !== "number") {
    return "timing unavailable";
  }

  return `${(durationMs / 1000).toFixed(2)}s`;
}

export function resolveSpeechPlaybackStatusLabel(playback: SpeechPlaybackState): string {
  if (playback.status === "audio") {
    return "audio playback";
  }

  if (playback.status === "timing") {
    return playback.audioReference ? "timing fallback" : "timing window";
  }

  if (playback.audioReference && !playback.audioSource) {
    return "awaiting safe audio route";
  }

  return "idle";
}

export function resolveSpeechPlaybackTransportLabel(playback: SpeechPlaybackState): string {
  if (playback.transport === "audio_reference") {
    return playback.audioSource ? "browser-safe audio reference" : "audio reference pending browser-safe route";
  }

  if (playback.transport === "timing_window") {
    return "canonical timing metadata";
  }

  return "none";
}

export function buildSurfaceHref(surfaceMode: "control" | "display"): string {
  if (typeof window === "undefined") {
    return surfaceMode === "display" ? "/display/" : "/control/";
  }

  const url = new URL(window.location.href);
  const pathSegments = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);

  if (pathSegments[pathSegments.length - 1] === "control" || pathSegments[pathSegments.length - 1] === "display") {
    pathSegments.pop();
  }

  pathSegments.push(surfaceMode);

  return `/${pathSegments.join("/")}/${url.search}${url.hash}`;
}

interface SurfaceModeSwitchProps {
  surfaceMode: "control" | "display";
  controlSurfaceHref: string;
  displaySurfaceHref: string;
}

export function SurfaceModeSwitch({
  surfaceMode,
  controlSurfaceHref,
  displaySurfaceHref
}: SurfaceModeSwitchProps): JSX.Element {
  const alternateSurfaceHref = surfaceMode === "control" ? displaySurfaceHref : controlSurfaceHref;
  const alternateSurfaceLabel = surfaceMode === "control" ? "Open display window" : "Open control window";
  const alternateSurfaceTarget = surfaceMode === "control" ? "_blank" : undefined;

  return (
    <nav className={surfaceMode === "display" ? "surface-switcher surface-switcher--display" : "surface-switcher"} aria-label="Surface mode">
      <a
        className={surfaceMode === "control" ? "surface-switcher__button surface-switcher__button--active" : "surface-switcher__button"}
        aria-current={surfaceMode === "control" ? "page" : undefined}
        href={controlSurfaceHref}
      >
        Control surface
      </a>
      <a
        className={surfaceMode === "display" ? "surface-switcher__button surface-switcher__button--active" : "surface-switcher__button"}
        aria-current={surfaceMode === "display" ? "page" : undefined}
        href={displaySurfaceHref}
      >
        Display surface
      </a>
      <a
        className="surface-switcher__link"
        href={alternateSurfaceHref}
        target={alternateSurfaceTarget}
        rel={alternateSurfaceTarget ? "noreferrer" : undefined}
      >
        {alternateSurfaceLabel}
      </a>
    </nav>
  );
}

interface SpeechLifecyclePanelProps {
  state: SpeechLifecycleLoadState;
  snapshot: SpeechLifecycleSnapshot;
  message: string | null;
  characterId: string;
  canonicalTranscription: BackendSpeechTranscriptionDocument | null;
  canonicalSynthesis: BackendSpeechSynthesisDocument | null;
}

function SpeechLifecyclePanel({
  state,
  snapshot,
  message,
  characterId,
  canonicalTranscription,
  canonicalSynthesis
}: SpeechLifecyclePanelProps): JSX.Element {
  return (
    <section className="speech-panel" aria-labelledby="speech-panel-title">
      <div className="speech-panel__header">
        <div>
          <p className="eyebrow">Speech lifecycle</p>
          <h2 id="speech-panel-title">Backend read surface</h2>
        </div>
        {snapshot ? <span className="speech-panel__count">{snapshot.eventCount} events</span> : null}
      </div>

      {state.status === "loading" ? <p className="speech-panel__message">Loading canonical speech lifecycle snapshot...</p> : null}
      {state.status === "offline" ? <p className="speech-panel__message speech-panel__message--error">{state.message}</p> : null}

      {snapshot ? (
        <>
          {message ? <p className="speech-panel__message">{message}</p> : null}

          <dl className="speech-panel__summary-list">
            <div>
              <dt>Session</dt>
              <dd>{snapshot.sessionId}</dd>
            </div>
            <div>
              <dt>Next cursor</dt>
              <dd>{snapshot.nextCursor}</dd>
            </div>
            <div>
              <dt>Event order</dt>
              <dd>{snapshot.orderedEnvelopePreserved ? "preserved" : "unexpected"}</dd>
            </div>
            <div>
              <dt>Character</dt>
              <dd>{characterId}</dd>
            </div>
          </dl>

          <div className="speech-panel__event-grid">
            <article className="speech-panel__event">
              <h3>Transcription</h3>
              <p className="speech-panel__event-status">
                {canonicalTranscription?.status ?? snapshot.canonicalTranscriptionEvent?.status ?? "unavailable"}
              </p>
              <p className="speech-panel__event-text">
                {canonicalTranscription?.transcript ?? "No canonical transcription event is present in the current snapshot."}
              </p>
              <p className="speech-panel__event-meta">
                {canonicalTranscription?.profile_id ?? "profile unavailable"} · {canonicalTranscription?.locale ?? "locale unavailable"}
                {" · "}
                {formatDurationLabel(canonicalTranscription?.timing?.utterance_duration_ms)}
              </p>
            </article>

            <article className="speech-panel__event">
              <h3>Synthesis</h3>
              <p className="speech-panel__event-status">
                {canonicalSynthesis?.status ?? snapshot.canonicalSpeechSynthesisEvent?.status ?? "unavailable"}
              </p>
              <p className="speech-panel__event-text">
                {canonicalSynthesis?.text ?? "No canonical synthesis event is present in the current snapshot."}
              </p>
              <p className="speech-panel__event-meta">
                {canonicalSynthesis?.profile_id ?? "profile unavailable"} · {canonicalSynthesis?.locale ?? "locale unavailable"}
                {" · "}
                {formatDurationLabel(canonicalSynthesis?.timing?.utterance_duration_ms)}
              </p>
            </article>
          </div>
        </>
      ) : null}
    </section>
  );
}

interface ControlSurfaceShellProps {
  loadState: CatalogLoadState;
  selectedCharacter: CharacterCatalogEntry | null;
  selectedCharacterId: CharacterId | null;
  onSelectCharacter: (characterId: CharacterId) => void;
  onCommandPublished: (response: BackendOperatorCommandResponseDocument | null) => void;
  backendStatusMessage: string;
  backendSyncState: BackendSyncState;
  speechLifecycleState: SpeechLifecycleLoadState;
  speechPlaybackStatus: SpeechPlaybackState;
  displaySettings: UseDisplaySettingsResult;
}

type ControlTabId = "character" | "tracking" | "llm" | "tts" | "stt" | "performance" | "advanced";

const CONTROL_TABS: ReadonlyArray<{ id: ControlTabId; label: string; hint: string }> = [
  { id: "character", label: "Character", hint: "Selector · wardrobe · motion · personality" },
  { id: "tracking", label: "Tracking & Audio", hint: "Camera focus tracking · audio playback" },
  { id: "llm", label: "LLM", hint: "Text questions · assistant relay" },
  { id: "tts", label: "TTS", hint: "Voice reference · synthesis preview" },
  { id: "stt", label: "STT", hint: "Hot mic · push-to-talk" },
  { id: "performance", label: "Performance", hint: "GPU / CPU / memory monitor" },
  { id: "advanced", label: "Other / Advanced", hint: "Lifecycle telemetry · session · background" }
];

export function ControlSurfaceShell({
  loadState,
  selectedCharacter,
  selectedCharacterId,
  onSelectCharacter,
  onCommandPublished,
  backendStatusMessage,
  backendSyncState,
  speechLifecycleState,
  speechPlaybackStatus,
  displaySettings
}: ControlSurfaceShellProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<ControlTabId>("character");
  const resourceState = useResourceMonitor();
  const speechLifecycleSnapshot = speechLifecycleState.snapshot;
  const speechLifecycleMessage = describeSpeechLifecycleStateMessage(speechLifecycleState);
  const speechDeliveryLabel = resolveSpeechLifecycleDeliveryLabel(speechLifecycleState);
  const speechPlaybackStatusLabel = resolveSpeechPlaybackStatusLabel(speechPlaybackStatus);
  const speechPlaybackTransportLabel = resolveSpeechPlaybackTransportLabel(speechPlaybackStatus);
  const canonicalTranscription = speechLifecycleSnapshot?.canonicalTranscriptionEvent?.transcription ?? null;
  const canonicalSynthesis = speechLifecycleSnapshot?.canonicalSpeechSynthesisEvent?.synthesis ?? null;
  const speechLifecycleCharacterId =
    resolveSpeechLifecycleCharacterId(speechLifecycleSnapshot) ?? selectedCharacter?.summary.characterId ?? "Unknown";
  const controlSurfaceHref = buildSurfaceHref("control");
  const displaySurfaceHref = buildSurfaceHref("display");

  const audioPlaybackPanel = speechPlaybackStatus.audioSource ? (
    <section className="surface-panel control-layout__audio-panel">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Audio playback</p>
          <h2>Debug player</h2>
        </div>
      </div>
      <audio controls src={speechPlaybackStatus.audioSource} className="control-layout__audio-player" />
      <p className="surface-panel__summary control-layout__audio-source">{speechPlaybackStatus.audioSource}</p>
    </section>
  ) : null;

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div>
          <p className="eyebrow">Control entrypoint</p>
          <h1>NikoF control surface</h1>
        </div>
        <p className="app-shell__summary">
          Launch this operator shell at `/control`. It keeps manifest-backed catalog selection, backend-confirmed session status, and speech lifecycle telemetry in one place while the display surface stays presentation-first.
        </p>
        <SurfaceModeSwitch
          surfaceMode="control"
          controlSurfaceHref={controlSurfaceHref}
          displaySurfaceHref={displaySurfaceHref}
        />
      </header>

      <nav className="control-tabs" role="tablist" aria-label="Control surface sections">
        {CONTROL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`control-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`control-tabpanel-${tab.id}`}
            className={activeTab === tab.id ? "control-tabs__tab control-tabs__tab--active" : "control-tabs__tab"}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="control-tabs__tab-label">{tab.label}</span>
            <span className="control-tabs__tab-hint">{tab.hint}</span>
          </button>
        ))}
      </nav>

      <main className="app-shell__content app-shell__content--control">
        <section
          className="control-tabpanel"
          role="tabpanel"
          id={`control-tabpanel-${activeTab}`}
          aria-labelledby={`control-tab-${activeTab}`}
        >
          {activeTab === "character" ? (
            <div className="control-tabpanel__grid control-tabpanel__grid--character">
              <div className="control-tabpanel__column">
                <CharacterCatalogPanel
                  catalog={loadState.catalog}
                  error={loadState.error}
                  isLoading={loadState.status === "loading"}
                  statusMessage={loadState.status === "ready" ? backendStatusMessage : null}
                  selectedCharacterId={selectedCharacterId}
                  onSelectCharacter={onSelectCharacter}
                />
                <ControlSurfaceCharacterProfilePanel />
              </div>
              <div className="control-tabpanel__column">
                <ControlSurfaceDisplayPanel
                  activeCharacterId={selectedCharacter?.summary.characterId ?? null}
                  boneOverlayEnabled={displaySettings.boneOverlayEnabled}
                  captionsEnabled={displaySettings.captionsEnabled}
                  wardrobe={displaySettings.wardrobe}
                  onSetBoneOverlay={displaySettings.setBoneOverlay}
                  onSetCaptions={displaySettings.setCaptions}
                  onSetWardrobeControl={displaySettings.setWardrobeControl}
                />
                <ControlSurfaceGesturePanel />
              </div>
            </div>
          ) : null}

          {activeTab === "tracking" ? (
            <div className="control-tabpanel__grid">
              <ControlSurfaceAttentionPanel />
              <ControlSurfaceAudioOutputPanel />
              {audioPlaybackPanel}
            </div>
          ) : null}

          {activeTab === "llm" ? (
            <div className="control-tabpanel__grid">
              <ControlSurfaceOperatorCommandPanel
                variant="llm"
                selectedCharacter={selectedCharacter}
                speechLifecycleState={speechLifecycleState}
                speechPlaybackStatus={speechPlaybackStatus}
                onCommandPublished={onCommandPublished}
              />
            </div>
          ) : null}

          {activeTab === "tts" ? (
            <div className="control-tabpanel__grid">
              <ControlSurfaceKokoroVoicePanel />
              <ControlSurfaceTtsSettingsPanel />
              <ControlSurfaceOperatorCommandPanel
                variant="tts"
                selectedCharacter={selectedCharacter}
                speechLifecycleState={speechLifecycleState}
                speechPlaybackStatus={speechPlaybackStatus}
                onCommandPublished={onCommandPublished}
              />
              {audioPlaybackPanel}
            </div>
          ) : null}

          {activeTab === "stt" ? (
            <div className="control-tabpanel__grid">
              <ControlSurfaceSttPanel />
            </div>
          ) : null}

          {activeTab === "performance" ? (
            <div className="control-tabpanel__grid">
              <ResourceMonitorPanel resourceState={resourceState} />
            </div>
          ) : null}

          {activeTab === "advanced" ? (
            <div className="control-tabpanel__grid control-tabpanel__grid--advanced">
              <ControlSurfaceSummaryPanel
                selectedCharacter={selectedCharacter}
                backendStatusMessage={backendStatusMessage}
                sessionId={backendSyncState.sessionId}
                healthPayload={backendSyncState.healthPayload}
                speechDeliveryLabel={speechDeliveryLabel}
                speechPlaybackStatusLabel={speechPlaybackStatusLabel}
                speechPlaybackTransportLabel={speechPlaybackTransportLabel}
                speechPlaybackMessage={speechPlaybackStatus.playbackKey ? speechPlaybackStatus.message : null}
                speechLifecycleNextCursor={speechLifecycleSnapshot?.nextCursor ?? null}
              />
              <SpeechLifecyclePanel
                state={speechLifecycleState}
                snapshot={speechLifecycleSnapshot}
                message={speechLifecycleMessage}
                characterId={speechLifecycleCharacterId}
                canonicalTranscription={canonicalTranscription}
                canonicalSynthesis={canonicalSynthesis}
              />
              <ControlSurfaceSpeechPlaybackPanel speechPlaybackStatus={speechPlaybackStatus} />
              <ControlSurfaceBackgroundPanel />
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}