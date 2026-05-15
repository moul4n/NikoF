import React, { useEffect, useState } from "react";
import { ControlSurfaceOperatorCommandPanel } from "./ControlSurfaceOperatorCommandPanel";
import { AvatarStage } from "../avatar/components/AvatarStage";
import { CharacterCatalogPanel } from "../avatar/components/CharacterCatalogPanel";
import {
  startSessionAnimationLiveConsumption,
  type ConsumedSessionAnimationSnapshot,
  type SessionAnimationDeliveryMode,
  updateSessionAnimationLifecycleState
} from "../avatar/loaders/sessionAnimation";
import {
  ActiveCharacterSyncError,
  bridgeCharacterCatalogWithBackend,
  loadCharacterCatalog,
  syncActiveCharacterSelection
} from "../avatar/loaders/characterCatalog";
import {
  createRejectedActiveCharacterSyncState,
  createSuccessfulActiveCharacterSyncState,
  resolveSelectedCharacterId
} from "../avatar/loaders/backendCharacterFlow";
import {
  startSpeechLifecycleLiveConsumption,
  type ConsumedSpeechLifecycleSnapshot,
  type SpeechLifecycleDeliveryMode
} from "../avatar/loaders/speechLifecycle";
import { cloneDefaultBaseAnimationCommand } from "../avatar/runtime/defaultBaseAnimation";
import { createAvatarRuntime, type AvatarRuntimeBridge } from "../avatar/runtime/avatarRuntime";
import type { SemanticAnimationCommand } from "../shared/types/animation";
import type {
  BackendSessionEventDocument,
  BackendOperatorCommandResponseDocument,
  BackendSpeechSynthesisDocument,
  BackendSpeechTranscriptionDocument,
  BackendSpeechVisemeSlotDocument,
  CharacterCatalog,
  CharacterCatalogEntry,
  CharacterId
} from "../shared/types/character";

type ImportMetaWithOptionalEnv = ImportMeta & {
  env?: {
    VITE_BACKEND_API_BASE_URL?: string;
  };
};

type CatalogLoadState =
  | {
      status: "loading";
      catalog: null;
      error: null;
    }
  | {
      status: "ready";
      catalog: CharacterCatalog;
      error: null;
    }
  | {
      status: "error";
      catalog: null;
      error: string;
    };

type BackendSyncState = {
  summariesConnected: boolean;
  activeCharacterConnected: boolean;
  sessionId: string | null;
  message: string | null;
};

type SpeechLifecycleLoadState = {
  status: "loading" | "ready" | "offline";
  snapshot: ConsumedSpeechLifecycleSnapshot | null;
  deliveryMode: SpeechLifecycleDeliveryMode;
  message: string | null;
};

type SessionAnimationLoadState = {
  status: "loading" | "ready" | "offline";
  snapshot: ConsumedSessionAnimationSnapshot | null;
  deliveryMode: SessionAnimationDeliveryMode;
  message: string | null;
};

type SpeechPlaybackStatus = "idle" | "audio" | "timing";

export type SurfaceMode = "control" | "display";

const frontendBackendApiBaseUrl = resolveFrontendBackendApiBaseUrl();

const DEV_DISPLAY_ANIMATION_OPTIONS = [
  {
    id: "backend",
    label: "Backend live",
    description: "Use the backend-selected session animation, or the local idle fallback when backend delivery is offline.",
    semanticCommand: null
  },
  {
    id: "idle.default",
    label: "Force idle.default",
    description: "Loop the refreshed shared idle clip directly in the display window.",
    semanticCommand: {
      id: "idle.default",
      source: "shared",
      playback: "loop"
    }
  },
  {
    id: "gesture.punch.once",
    label: "Force gesture.punch.once",
    description: "Replay the shared punch clip to inspect elbow, lower-arm rotation, and wrist delivery.",
    semanticCommand: {
      id: "gesture.punch.once",
      source: "shared",
      playback: "once"
    }
  }
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  semanticCommand: SemanticAnimationCommand | null;
}>;

type DevDisplayAnimationOptionId = (typeof DEV_DISPLAY_ANIMATION_OPTIONS)[number]["id"];

type DevDisplayAnimationOverrideState = {
  optionId: DevDisplayAnimationOptionId;
  activationKey: number;
};

function findCharacterEntry(catalog: CharacterCatalog | null, characterId: CharacterId | null): CharacterCatalogEntry | null {
  if (!catalog || !characterId) {
    return null;
  }

  return catalog.entries.find((entry) => entry.summary.characterId === characterId) ?? null;
}

function resolveRenderableCharacterEntry(
  catalog: CharacterCatalog | null,
  preferredCharacterId: CharacterId | null
): CharacterCatalogEntry | null {
  if (!catalog) {
    return null;
  }

  return findCharacterEntry(catalog, resolveSelectedCharacterId(catalog, preferredCharacterId));
}

function resolveDevDisplayAnimationOption(optionId: DevDisplayAnimationOptionId) {
  return DEV_DISPLAY_ANIMATION_OPTIONS.find((option) => option.id === optionId) ?? DEV_DISPLAY_ANIMATION_OPTIONS[0];
}

function describeBackendSyncState(syncState: BackendSyncState): string {
  if (syncState.message) {
    return syncState.message;
  }

  if (syncState.summariesConnected && syncState.activeCharacterConnected) {
    return "Backend bridge connected: shell is overlaying backend summaries and active-character state onto the local manifest catalog.";
  }

  if (syncState.summariesConnected) {
    return "Backend summaries connected; active-character selection is still local in this session.";
  }

  return "Backend bridge offline; shell is using the local manifest catalog only.";
}

function formatDurationLabel(durationMs: number | null | undefined): string {
  if (typeof durationMs !== "number") {
    return "timing unavailable";
  }

  return `${(durationMs / 1000).toFixed(2)}s`;
}

function resolveSpeechReactionInput(synthesis: BackendSpeechSynthesisDocument): {
  utteranceDurationMs: number | null;
  visemeSlots: BackendSpeechVisemeSlotDocument[];
} {
  return {
    utteranceDurationMs: synthesis.timing?.utterance_duration_ms ?? null,
    visemeSlots: synthesis.timing?.viseme_slots ?? []
  };
}

function resolveDesiredAnimationLifecycleState(speechPlaybackStatus: SpeechPlaybackStatus): "idle" | "speak" {
  return speechPlaybackStatus === "idle" ? "idle" : "speak";
}

function parseSpeechLifecycleCursor(cursor: string | null | undefined): {
  sessionId: string;
  sequence: number;
} | null {
  const trimmedCursor = cursor?.trim();

  if (!trimmedCursor) {
    return null;
  }

  const match = /^speech\.lifecycle:([^:]+):(\d+)$/.exec(trimmedCursor);

  if (!match) {
    return null;
  }

  return {
    sessionId: match[1],
    sequence: Number.parseInt(match[2], 10)
  };
}

function hasSpeechLifecycleSnapshotCaughtUp(
  snapshot: ConsumedSpeechLifecycleSnapshot | null,
  publishedCommand: BackendOperatorCommandResponseDocument | null
): boolean {
  const snapshotCursor = parseSpeechLifecycleCursor(snapshot?.nextCursor ?? null);
  const publishedCursor = parseSpeechLifecycleCursor(publishedCommand?.next_speech_cursor ?? null);

  if (!snapshotCursor || !publishedCursor) {
    return false;
  }

  return snapshotCursor.sessionId === publishedCursor.sessionId && snapshotCursor.sequence >= publishedCursor.sequence;
}

function hasPendingPublishedSpeechLifecycle(
  snapshot: ConsumedSpeechLifecycleSnapshot | null,
  publishedCommand: BackendOperatorCommandResponseDocument | null
): boolean {
  if (!publishedCommand || publishedCommand.status !== "ready") {
    return false;
  }

  const publishedCanonicalSpeech = publishedCommand.speech_lifecycle_events.some(
    (envelope) => envelope.event.event_type === "speech.synthesis"
  );

  if (!publishedCanonicalSpeech) {
    return false;
  }

  return !hasSpeechLifecycleSnapshotCaughtUp(snapshot, publishedCommand);
}

function hasActiveCanonicalTranscription(snapshot: ConsumedSpeechLifecycleSnapshot | null): boolean {
  const transcriptionStatus = snapshot?.canonicalTranscriptionEvent?.transcription?.status?.trim().toLowerCase();

  if (!transcriptionStatus) {
    return false;
  }

  return !["degraded", "error", "final", "ready", "unavailable"].includes(transcriptionStatus);
}

function resolveDesiredConversationAnimationLifecycleState(
  speechSnapshot: ConsumedSpeechLifecycleSnapshot | null,
  publishedCommand: BackendOperatorCommandResponseDocument | null,
  speechPlaybackStatus: SpeechPlaybackStatus
): "idle" | "listen" | "speak" {
  if (hasPendingPublishedSpeechLifecycle(speechSnapshot, publishedCommand)) {
    return "speak";
  }

  if (speechPlaybackStatus !== "idle" && speechSnapshot?.canonicalSpeechSynthesisEvent?.synthesis) {
    return "speak";
  }

  if (hasActiveCanonicalTranscription(speechSnapshot)) {
    return "listen";
  }

  return "idle";
}

function resolveAnimationLifecycleUpdateReason(
  lifecycleState: "idle" | "listen" | "speak",
  speechSnapshot: ConsumedSpeechLifecycleSnapshot | null,
  publishedCommand: BackendOperatorCommandResponseDocument | null,
  speechPlaybackStatus: SpeechPlaybackStatus
): string {
  if (lifecycleState === "listen") {
    return "canonical_transcription_active";
  }

  if (lifecycleState === "speak") {
    if (hasPendingPublishedSpeechLifecycle(speechSnapshot, publishedCommand)) {
      return "canonical_command_published";
    }

    if (speechPlaybackStatus !== "idle") {
      return "canonical_speech_playback_active";
    }

    return "canonical_synthesis_active";
  }

  return "conversation_idle";
}

function resolveFrontendBackendApiBaseUrl(): string {
  const configuredBaseUrl = (import.meta as ImportMetaWithOptionalEnv).env?.VITE_BACKEND_API_BASE_URL?.trim();

  if (!configuredBaseUrl) {
    return "/api";
  }

  return configuredBaseUrl.replace(/\/+$/, "");
}

function looksLikeWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function buildSpeechSynthesisPlaybackKey(event: BackendSessionEventDocument | null): string | null {
  if (!event?.synthesis) {
    return null;
  }

  return [
    event.session_id,
    event.character_id,
    event.timestamp,
    event.status,
    event.synthesis.profile_id,
    event.synthesis.locale,
    event.synthesis.text,
    event.synthesis.audio_reference ?? ""
  ].join("|");
}

function resolveSpeechSynthesisAudioSource(audioReference: string | null | undefined): string | null {
  const trimmedReference = audioReference?.trim();

  if (!trimmedReference || trimmedReference.startsWith("session://")) {
    return null;
  }

  if (/^(https?:|blob:|data:|file:)/i.test(trimmedReference)) {
    return trimmedReference;
  }

  if (looksLikeWindowsAbsolutePath(trimmedReference)) {
    return `file:///${trimmedReference.replace(/\\/g, "/")}`;
  }

  if (trimmedReference.startsWith("/")) {
    return trimmedReference;
  }

  const normalizedReference = trimmedReference.replace(/^\.?\//, "");

  if (normalizedReference.startsWith("api/")) {
    return `/${normalizedReference}`;
  }

  return `${frontendBackendApiBaseUrl}/${normalizedReference}`;
}

function describeSpeechLifecycleStateMessage(state: SpeechLifecycleLoadState): string | null {
  if (state.status !== "ready") {
    return state.message;
  }

  if (state.deliveryMode === "live") {
    return "Live SSE is connected on the backend-owned speech.lifecycle envelope.";
  }

  return state.message ?? "The shell is reading the backend-owned snapshot envelope while live delivery is unavailable.";
}

function resolveSpeechLifecycleCharacterId(snapshot: ConsumedSpeechLifecycleSnapshot | null): CharacterId | null {
  return snapshot?.canonicalSpeechSynthesisEvent?.character_id ?? snapshot?.canonicalTranscriptionEvent?.character_id ?? null;
}

function resolveDisplayReplySnapshot(snapshot: ConsumedSpeechLifecycleSnapshot | null): {
  label: string | null;
  status: string | null;
  text: string | null;
} {
  const replyEvent = snapshot?.canonicalSpeechSynthesisEvent;

  if (!replyEvent) {
    return {
      label: null,
      status: null,
      text: null
    };
  }

  const assistantText = replyEvent.assistant?.text?.trim();

  if (assistantText) {
    return {
      label: "Assistant reply",
      status: replyEvent.assistant?.status ?? replyEvent.status,
      text: assistantText
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

function buildSurfaceHref(surfaceMode: SurfaceMode): string {
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
  surfaceMode: SurfaceMode;
  controlSurfaceHref: string;
  displaySurfaceHref: string;
}

function SurfaceModeSwitch({ surfaceMode, controlSurfaceHref, displaySurfaceHref }: SurfaceModeSwitchProps): JSX.Element {
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
  snapshot: ConsumedSpeechLifecycleSnapshot | null;
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

interface ControlSurfaceSummaryPanelProps {
  selectedCharacter: CharacterCatalogEntry | null;
  backendStatusMessage: string;
  backendSyncState: BackendSyncState;
  speechLifecycleState: SpeechLifecycleLoadState;
  speechLifecycleSnapshot: ConsumedSpeechLifecycleSnapshot | null;
  speechPlaybackStatusLabel: string;
}

function ControlSurfaceSummaryPanel({
  selectedCharacter,
  backendStatusMessage,
  backendSyncState,
  speechLifecycleState,
  speechLifecycleSnapshot,
  speechPlaybackStatusLabel
}: ControlSurfaceSummaryPanelProps): JSX.Element {
  const speechDeliveryLabel =
    speechLifecycleState.status === "offline"
      ? "offline"
      : speechLifecycleState.status === "loading"
        ? "loading"
        : speechLifecycleState.deliveryMode === "live"
          ? "live SSE"
          : "snapshot fallback";

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
          <dd>{backendSyncState.sessionId ?? "No backend session id available"}</dd>
        </div>
        <div>
          <dt>Speech delivery</dt>
          <dd>{speechDeliveryLabel}</dd>
        </div>
        <div>
          <dt>Playback bridge</dt>
          <dd>{speechPlaybackStatusLabel}</dd>
        </div>
      </dl>

      <p className="surface-panel__summary">
        The control surface keeps catalog selection, backend-confirmed active-character state, and speech lifecycle status in one shell while the display surface stays presentation-only.
      </p>
      {speechLifecycleSnapshot ? (
        <p className="surface-panel__summary">
          Current speech lifecycle cursor: {speechLifecycleSnapshot.nextCursor}.
        </p>
      ) : null}
    </section>
  );
}

interface DisplaySurfaceStatusPanelProps {
  selectedCharacter: CharacterCatalogEntry | null;
  backendStatusMessage: string;
  speechLifecycleState: SpeechLifecycleLoadState;
  speechLifecycleSnapshot: ConsumedSpeechLifecycleSnapshot | null;
  speechLifecycleMessage: string | null;
  replyActivityLabel: string | null;
  replyActivityStatus: string | null;
  replyActivityText: string | null;
  speechPlaybackStatusLabel: string;
}

function DisplaySurfaceStatusPanel({
  selectedCharacter,
  backendStatusMessage,
  speechLifecycleState,
  speechLifecycleSnapshot,
  speechLifecycleMessage,
  replyActivityLabel,
  replyActivityStatus,
  replyActivityText,
  speechPlaybackStatusLabel
}: DisplaySurfaceStatusPanelProps): JSX.Element {
  const speechDeliveryLabel =
    speechLifecycleState.status === "offline"
      ? "offline"
      : speechLifecycleState.status === "loading"
        ? "loading"
        : speechLifecycleState.deliveryMode === "live"
          ? "live SSE"
          : "snapshot fallback";

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
          <dd>{speechDeliveryLabel}</dd>
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
      </dl>

      <p className="surface-panel__message">{backendStatusMessage}</p>
      {speechLifecycleMessage ? <p className="surface-panel__summary">{speechLifecycleMessage}</p> : null}
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

interface DevAnimationSwitcherPanelProps {
  selectedOptionId: DevDisplayAnimationOptionId;
  backendAnimationId: string | null;
  onSelectOption: (optionId: DevDisplayAnimationOptionId) => void;
}

function DevAnimationSwitcherPanel({
  selectedOptionId,
  backendAnimationId,
  onSelectOption
}: DevAnimationSwitcherPanelProps): JSX.Element {
  return (
    <section className="surface-panel surface-panel--display dev-animation-panel" aria-labelledby="dev-animation-switcher-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Dev-only animation override</p>
          <h2 id="dev-animation-switcher-title">Local display switcher</h2>
        </div>
      </div>

      <p className="surface-panel__summary">
        This panel is dev-only and only affects the local display window. Click the punch option again to replay the one-shot clip.
      </p>
      <p className="surface-panel__message">
        Backend snapshot: {backendAnimationId ?? "Unavailable, so the local idle fallback will be used when override is off."}
      </p>

      <div className="dev-animation-panel__list" role="group" aria-label="Display animation override">
        {DEV_DISPLAY_ANIMATION_OPTIONS.map((option) => {
          const isActive = option.id === selectedOptionId;

          return (
            <button
              key={option.id}
              type="button"
              className={isActive ? "dev-animation-panel__button dev-animation-panel__button--active" : "dev-animation-panel__button"}
              aria-pressed={isActive}
              onClick={() => onSelectOption(option.id)}
            >
              <span className="dev-animation-panel__button-title">{option.label}</span>
              <span className="dev-animation-panel__button-summary">{option.description}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

interface AppProps {
  surfaceMode: SurfaceMode;
}

export function App({ surfaceMode }: AppProps): JSX.Element {
  const [runtime] = useState<AvatarRuntimeBridge>(() => createAvatarRuntime());
  const isDevAnimationSwitcherEnabled = import.meta.env.DEV;
  const [loadState, setLoadState] = useState<CatalogLoadState>({
    status: "loading",
    catalog: null,
    error: null
  });
  const [backendSyncState, setBackendSyncState] = useState<BackendSyncState>({
    summariesConnected: false,
    activeCharacterConnected: false,
    sessionId: null,
    message: null
  });
  const [speechLifecycleState, setSpeechLifecycleState] = useState<SpeechLifecycleLoadState>({
    status: "loading",
    snapshot: null,
    deliveryMode: "snapshot",
    message: null
  });
  const [sessionAnimationState, setSessionAnimationState] = useState<SessionAnimationLoadState>({
    status: "loading",
    snapshot: null,
    deliveryMode: "snapshot",
    message: null
  });
  const [speechLifecycleRefreshKey, setSpeechLifecycleRefreshKey] = useState(0);
  const [selectedCharacterId, setSelectedCharacterId] = useState<CharacterId | null>(null);
  const [speechPlaybackStatus, setSpeechPlaybackStatus] = useState<SpeechPlaybackStatus>("idle");
  const [devDisplayAnimationOverride, setDevDisplayAnimationOverride] = useState<DevDisplayAnimationOverrideState>({
    optionId: "backend",
    activationKey: 0
  });
  const [latestPublishedCommand, setLatestPublishedCommand] = useState<BackendOperatorCommandResponseDocument | null>(null);
  const [animationLifecycleBridge] = useState(() => ({
    requestedStateKey: null as string | null
  }));
  const [speechPlaybackBridge] = useState(() => ({
    activeAudio: null as HTMLAudioElement | null,
    playbackTimeoutId: null as number | null,
    handledPlaybackKey: null as string | null
  }));

  function clearSpeechPlaybackTimeout(): void {
    if (speechPlaybackBridge.playbackTimeoutId !== null) {
      window.clearTimeout(speechPlaybackBridge.playbackTimeoutId);
      speechPlaybackBridge.playbackTimeoutId = null;
    }
  }

  function releaseSpeechAudio(): void {
    const activeAudio = speechPlaybackBridge.activeAudio;

    if (!activeAudio) {
      return;
    }

    activeAudio.pause();
    activeAudio.src = "";
    speechPlaybackBridge.activeAudio = null;
  }

  function stopSpeechPlayback(resetHandledKey: boolean): void {
    clearSpeechPlaybackTimeout();
    releaseSpeechAudio();
    runtime.clearSpeechReaction();
    setSpeechPlaybackStatus("idle");

    if (resetHandledKey) {
      speechPlaybackBridge.handledPlaybackKey = null;
    }
  }

  function beginTimingSpeechWindow(
    durationMs: number,
    playbackKey: string,
    speechReactionInput: ReturnType<typeof resolveSpeechReactionInput>
  ): void {
    clearSpeechPlaybackTimeout();
    releaseSpeechAudio();
    runtime.beginSpeechReaction(speechReactionInput);
    setSpeechPlaybackStatus("timing");
    speechPlaybackBridge.playbackTimeoutId = window.setTimeout(() => {
      if (speechPlaybackBridge.handledPlaybackKey !== playbackKey) {
        return;
      }

      runtime.clearSpeechReaction();
      setSpeechPlaybackStatus("idle");
      speechPlaybackBridge.playbackTimeoutId = null;
    }, durationMs);
  }

  function beginAudioSpeechPlayback(
    audioSource: string,
    durationMs: number | null,
    playbackKey: string,
    speechReactionInput: ReturnType<typeof resolveSpeechReactionInput>
  ): void {
    clearSpeechPlaybackTimeout();
    releaseSpeechAudio();

    const playbackAudio = new Audio(audioSource);
    let settled = false;

    speechPlaybackBridge.activeAudio = playbackAudio;

    const cleanupPlaybackAudio = (): void => {
      playbackAudio.removeEventListener("playing", handlePlaying);
      playbackAudio.removeEventListener("ended", handleEnded);
      playbackAudio.removeEventListener("error", handleError);

      if (speechPlaybackBridge.activeAudio === playbackAudio) {
        speechPlaybackBridge.activeAudio = null;
      }
    };

    const finishPlayback = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupPlaybackAudio();
      clearSpeechPlaybackTimeout();

      if (speechPlaybackBridge.handledPlaybackKey !== playbackKey) {
        return;
      }

      runtime.setState("idle");
      setSpeechPlaybackStatus("idle");
    };

    const fallbackToTiming = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupPlaybackAudio();

      if (typeof durationMs === "number" && durationMs > 0 && speechPlaybackBridge.handledPlaybackKey === playbackKey) {
        beginTimingSpeechWindow(durationMs, playbackKey, speechReactionInput);
        return;
      }

      if (speechPlaybackBridge.handledPlaybackKey !== playbackKey) {
        return;
      }

      runtime.clearSpeechReaction();
      setSpeechPlaybackStatus("idle");
    };

    const handlePlaying = (): void => {
      if (speechPlaybackBridge.handledPlaybackKey !== playbackKey) {
        return;
      }

      runtime.beginSpeechReaction(speechReactionInput);
      setSpeechPlaybackStatus("audio");

      if (typeof durationMs === "number" && durationMs > 0) {
        clearSpeechPlaybackTimeout();
        speechPlaybackBridge.playbackTimeoutId = window.setTimeout(() => {
          finishPlayback();
        }, durationMs);
      }
    };

    const handleEnded = (): void => {
      finishPlayback();
    };

    const handleError = (): void => {
      fallbackToTiming();
    };

    playbackAudio.addEventListener("playing", handlePlaying);
    playbackAudio.addEventListener("ended", handleEnded);
    playbackAudio.addEventListener("error", handleError);

    void playbackAudio.play().catch(() => {
      fallbackToTiming();
    });
  }

  useEffect(() => {
    let cancelled = false;

    void loadCharacterCatalog()
      .then((catalog) => {
        if (cancelled) {
          return;
        }

        setLoadState({
          status: "ready",
          catalog,
          error: null
        });
        setSelectedCharacterId(resolveSelectedCharacterId(catalog, null));

        void bridgeCharacterCatalogWithBackend(catalog).then((bridge) => {
          if (cancelled) {
            return;
          }

          const nextMessages = [...bridge.messages];
          const nextSelectedCharacterId = resolveSelectedCharacterId(bridge.catalog, bridge.activeCharacterId);

          if (bridge.activeCharacterId && !findCharacterEntry(bridge.catalog, bridge.activeCharacterId)) {
            nextMessages.push(
              `Backend selected ${bridge.activeCharacterId}, but this shell only mounts characters with a local manifest package in the repo.`
            );
          }

          setLoadState({
            status: "ready",
            catalog: bridge.catalog,
            error: null
          });
          setSelectedCharacterId(nextSelectedCharacterId);
          setBackendSyncState({
            summariesConnected: bridge.summariesConnected,
            activeCharacterConnected: bridge.activeCharacterConnected,
            sessionId: bridge.sessionId,
            message: nextMessages[0] ?? null
          });
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setLoadState({
          status: "error",
          catalog: null,
          error: error instanceof Error ? error.message : "Character catalog failed to load."
        });
      });

    return () => {
      cancelled = true;
      stopSpeechPlayback(true);
      runtime.unmount();
    };
  }, [runtime]);

  useEffect(() => {
    const activeCharacter = resolveRenderableCharacterEntry(loadState.catalog, selectedCharacterId);

    if (!activeCharacter) {
      return;
    }

    void runtime.loadCharacter(activeCharacter.summary);
    runtime.setState("idle");
  }, [loadState.catalog, runtime, selectedCharacterId]);

  useEffect(() => {
    if (surfaceMode === "display" && isDevAnimationSwitcherEnabled) {
      const selectedOption = resolveDevDisplayAnimationOption(devDisplayAnimationOverride.optionId);

      if (selectedOption.semanticCommand) {
        runtime.play({ ...selectedOption.semanticCommand });
        return;
      }
    }

    const activeAnimationSnapshot = sessionAnimationState.snapshot;

    if (activeAnimationSnapshot) {
      runtime.play(activeAnimationSnapshot.semanticCommand);
      return;
    }

    if (sessionAnimationState.status === "offline") {
      runtime.play(cloneDefaultBaseAnimationCommand());
    }
  }, [
    devDisplayAnimationOverride.activationKey,
    devDisplayAnimationOverride.optionId,
    isDevAnimationSwitcherEnabled,
    runtime,
    sessionAnimationState.snapshot,
    sessionAnimationState.status,
    surfaceMode
  ]);

  useEffect(() => {
    const activeCharacter = resolveRenderableCharacterEntry(loadState.catalog, selectedCharacterId);
    const currentAnimationSnapshot = sessionAnimationState.snapshot;

    if (surfaceMode !== "control") {
      return;
    }

    if (loadState.status !== "ready" || !activeCharacter) {
      return;
    }

    const desiredAnimationLifecycleState = resolveDesiredConversationAnimationLifecycleState(
      speechLifecycleState.snapshot,
      latestPublishedCommand,
      speechPlaybackStatus
    );
    const requestKey = `${activeCharacter.summary.characterId}:${desiredAnimationLifecycleState}`;

    if (animationLifecycleBridge.requestedStateKey === requestKey) {
      return;
    }

    if (
      currentAnimationSnapshot?.characterId === activeCharacter.summary.characterId &&
      currentAnimationSnapshot.lifecycleState === desiredAnimationLifecycleState
    ) {
      animationLifecycleBridge.requestedStateKey = requestKey;
      return;
    }

    animationLifecycleBridge.requestedStateKey = requestKey;

    let cancelled = false;

    void updateSessionAnimationLifecycleState(
      desiredAnimationLifecycleState,
      resolveAnimationLifecycleUpdateReason(
        desiredAnimationLifecycleState,
        speechLifecycleState.snapshot,
        latestPublishedCommand,
        speechPlaybackStatus
      )
    )
      .then((snapshot) => {
        if (cancelled) {
          return;
        }

        setSessionAnimationState((currentState) => ({
          status: "ready",
          snapshot,
          deliveryMode: currentState.deliveryMode,
          message: currentState.deliveryMode === "live" ? null : currentState.message
        }));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setSessionAnimationState((currentState) => {
          if (currentState.snapshot) {
            return currentState;
          }

          return {
            status: "offline",
            snapshot: null,
            deliveryMode: "snapshot",
            message: "Backend session animation update unavailable; viewer is holding the local idle fallback."
          };
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    animationLifecycleBridge,
    latestPublishedCommand,
    loadState.catalog,
    loadState.status,
    runtime,
    selectedCharacterId,
    sessionAnimationState.snapshot,
    speechLifecycleState.snapshot,
    speechPlaybackStatus,
    surfaceMode
  ]);

  useEffect(() => {
    if (loadState.status === "error") {
      setSessionAnimationState({
        status: "offline",
        snapshot: null,
        deliveryMode: "snapshot",
        message: "Session animation read surface unavailable until the local manifest catalog loads successfully."
      });
      return;
    }

    if (loadState.status !== "ready") {
      return;
    }

    let cancelled = false;
    let liveConsumption: { close(): void } | null = null;

    setSessionAnimationState((currentState) =>
      currentState.snapshot
        ? currentState
        : {
            status: "loading",
            snapshot: null,
            deliveryMode: "snapshot",
            message: null
          }
    );

    void startSessionAnimationLiveConsumption({
      onSnapshot: (snapshot, deliveryMode) => {
        if (cancelled) {
          return;
        }

        const reconciledCharacterId = resolveSelectedCharacterId(loadState.catalog, snapshot.characterId);

        if (reconciledCharacterId) {
          setSelectedCharacterId((currentCharacterId) =>
            currentCharacterId === reconciledCharacterId ? currentCharacterId : reconciledCharacterId
          );
        }

        setSessionAnimationState((currentState) => ({
          status: "ready",
          snapshot,
          deliveryMode,
          message: deliveryMode === "live" ? null : currentState.message
        }));
      },
      onDeliveryModeChange: (deliveryMode, error) => {
        if (cancelled) {
          return;
        }

        setSessionAnimationState((currentState) => {
          if (currentState.status === "offline") {
            return currentState;
          }

          return {
            status: currentState.snapshot ? "ready" : currentState.status,
            snapshot: currentState.snapshot,
            deliveryMode,
            message:
              deliveryMode === "live"
                ? null
                : error
                  ? `${error.message} The shell is continuing from the latest backend animation snapshot when available.`
                  : currentState.message
          };
        });
      }
    })
      .then((subscription) => {
        if (cancelled) {
          subscription.close();
          return;
        }

        liveConsumption = subscription;
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setSessionAnimationState({
          status: "offline",
          snapshot: null,
          deliveryMode: "snapshot",
          message:
            error instanceof Error
              ? `${error.message} The viewer is holding the local idle fallback until backend animation delivery returns.`
              : "Backend session animation snapshot unavailable."
        });
      });

    return () => {
      cancelled = true;
      liveConsumption?.close();
    };
  }, [loadState.catalog, loadState.status]);

  useEffect(() => {
    if (!latestPublishedCommand) {
      return;
    }

    if (!hasSpeechLifecycleSnapshotCaughtUp(speechLifecycleState.snapshot, latestPublishedCommand)) {
      return;
    }

    setLatestPublishedCommand((currentCommand) => {
      if (currentCommand?.next_speech_cursor !== latestPublishedCommand.next_speech_cursor) {
        return currentCommand;
      }

      return null;
    });
  }, [latestPublishedCommand, speechLifecycleState.snapshot]);

  useEffect(() => {
    if (loadState.status === "error") {
      setSpeechLifecycleState({
        status: "offline",
        snapshot: null,
        deliveryMode: "snapshot",
        message: "Speech lifecycle read surface unavailable until the local manifest catalog loads successfully."
      });
      return;
    }

    if (loadState.status !== "ready") {
      return;
    }

    let cancelled = false;
    let liveConsumption: { close(): void } | null = null;

    if (speechLifecycleRefreshKey === 0) {
      setSpeechLifecycleState({
        status: "loading",
        snapshot: null,
        deliveryMode: "snapshot",
        message: null
      });
    }

    void startSpeechLifecycleLiveConsumption({
      onSnapshot: (snapshot, deliveryMode) => {
        if (cancelled) {
          return;
        }

        setSpeechLifecycleState((currentState) => ({
          status: "ready",
          snapshot,
          deliveryMode,
          message: deliveryMode === "live" ? null : currentState.message
        }));
      },
      onDeliveryModeChange: (deliveryMode, error) => {
        if (cancelled) {
          return;
        }

        setSpeechLifecycleState((currentState) => {
          if (currentState.status === "offline") {
            return currentState;
          }

          return {
            status: currentState.snapshot ? "ready" : currentState.status,
            snapshot: currentState.snapshot,
            deliveryMode,
            message:
              deliveryMode === "live"
                ? null
                : error
                  ? `${error.message} The shell is continuing from the latest backend snapshot.`
                  : currentState.message
          };
        });
      }
    })
      .then((subscription) => {
        if (cancelled) {
          subscription.close();
          return;
        }

        liveConsumption = subscription;
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setSpeechLifecycleState({
          status: "offline",
          snapshot: null,
          deliveryMode: "snapshot",
          message:
            error instanceof Error
              ? `${error.message} The shell stays on backend-confirmed character state without live speech delivery in this slice.`
              : "Backend speech lifecycle snapshot unavailable."
        });
      });

    return () => {
      cancelled = true;
      liveConsumption?.close();
    };
  }, [loadState.status, speechLifecycleRefreshKey]);

  useEffect(() => {
    if (surfaceMode !== "display" || loadState.status !== "ready") {
      return;
    }

    const backendLifecycleCharacterId = resolveSpeechLifecycleCharacterId(speechLifecycleState.snapshot);

    if (!backendLifecycleCharacterId) {
      return;
    }

    const reconciledCharacterId = resolveSelectedCharacterId(loadState.catalog, backendLifecycleCharacterId);

    if (!reconciledCharacterId || reconciledCharacterId === selectedCharacterId) {
      return;
    }

    setSelectedCharacterId(reconciledCharacterId);
  }, [loadState, selectedCharacterId, speechLifecycleState.snapshot, surfaceMode]);

  const canonicalSynthesisEvent = speechLifecycleState.snapshot?.canonicalSpeechSynthesisEvent ?? null;

  useEffect(() => {
    const playbackKey = buildSpeechSynthesisPlaybackKey(canonicalSynthesisEvent);

    if (!playbackKey || !canonicalSynthesisEvent?.synthesis) {
      stopSpeechPlayback(true);
      return;
    }

    if (speechPlaybackBridge.handledPlaybackKey === playbackKey) {
      return;
    }

    stopSpeechPlayback(false);
    speechPlaybackBridge.handledPlaybackKey = playbackKey;

    const audioSource = resolveSpeechSynthesisAudioSource(canonicalSynthesisEvent.synthesis.audio_reference);
    const speechReactionInput = resolveSpeechReactionInput(canonicalSynthesisEvent.synthesis);
    const durationMs = speechReactionInput.utteranceDurationMs;

    if (audioSource) {
      beginAudioSpeechPlayback(audioSource, durationMs, playbackKey, speechReactionInput);
      return;
    }

    if (typeof durationMs === "number" && durationMs > 0) {
      beginTimingSpeechWindow(durationMs, playbackKey, speechReactionInput);
      return;
    }

    runtime.clearSpeechReaction();
    setSpeechPlaybackStatus("idle");
  }, [canonicalSynthesisEvent, runtime, speechPlaybackBridge]);

  function handleSelectCharacter(characterId: CharacterId): void {
    if (characterId === selectedCharacterId) {
      return;
    }

    setSelectedCharacterId(characterId);

    if (!backendSyncState.activeCharacterConnected) {
      return;
    }

    setBackendSyncState((currentState) => ({
      ...currentState,
      message: `Syncing ${characterId} to the backend active-character session...`
    }));

    void syncActiveCharacterSelection(characterId)
      .then((response) => {
        const nextSyncState = createSuccessfulActiveCharacterSyncState(loadState.catalog, response);

        setSelectedCharacterId(nextSyncState.selectedCharacterId);
        setSpeechLifecycleRefreshKey((currentKey) => currentKey + 1);
        setBackendSyncState((currentState) => ({
          ...currentState,
          ...nextSyncState
        }));
      })
      .catch((error: unknown) => {
        if (error instanceof ActiveCharacterSyncError) {
          const nextSyncState = createRejectedActiveCharacterSyncState(loadState.catalog, error.response);

          setSelectedCharacterId(nextSyncState.selectedCharacterId);
          setSpeechLifecycleRefreshKey((currentKey) => currentKey + 1);
          setBackendSyncState((currentState) => ({
            ...currentState,
            ...nextSyncState
          }));
          return;
        }

        setBackendSyncState((currentState) => ({
          ...currentState,
          message: error instanceof Error ? error.message : "Backend active-character sync failed; shell remains local."
        }));
      });
  }

  function handleCommandPublished(response: BackendOperatorCommandResponseDocument): void {
    const reconciledCharacterId = loadState.catalog
      ? resolveSelectedCharacterId(loadState.catalog, response.character_id)
      : response.character_id;

    setLatestPublishedCommand(response);

    if (reconciledCharacterId && reconciledCharacterId !== selectedCharacterId) {
      setSelectedCharacterId(reconciledCharacterId);
    }

    setSpeechLifecycleRefreshKey((currentKey) => currentKey + 1);
  }

  function handleSelectDevDisplayAnimation(optionId: DevDisplayAnimationOptionId): void {
    if (!isDevAnimationSwitcherEnabled) {
      return;
    }

    setDevDisplayAnimationOverride((currentState) => ({
      optionId,
      activationKey: currentState.activationKey + 1
    }));
  }

  const selectedCharacter = resolveRenderableCharacterEntry(loadState.catalog, selectedCharacterId);
  const backendStatusMessage = describeBackendSyncState(backendSyncState);
  const speechLifecycleSnapshot = speechLifecycleState.snapshot;
  const speechLifecycleMessage = describeSpeechLifecycleStateMessage(speechLifecycleState);
  const canonicalTranscription = speechLifecycleSnapshot?.canonicalTranscriptionEvent?.transcription ?? null;
  const canonicalSynthesis = speechLifecycleSnapshot?.canonicalSpeechSynthesisEvent?.synthesis ?? null;
  const displayReplySnapshot = resolveDisplayReplySnapshot(speechLifecycleSnapshot);
  const speechPlaybackStatusLabel =
    speechPlaybackStatus === "audio"
      ? "audio playback"
      : speechPlaybackStatus === "timing"
        ? "timing window"
        : "idle";
  const speechLifecycleCharacterId =
    resolveSpeechLifecycleCharacterId(speechLifecycleSnapshot) ?? selectedCharacter?.summary.characterId ?? "Unknown";
  const controlSurfaceHref = buildSurfaceHref("control");
  const displaySurfaceHref = buildSurfaceHref("display");
  const backendAnimationId = sessionAnimationState.snapshot?.semanticCommand.id ?? null;

  if (surfaceMode === "display") {
    return (
      <div className="app-shell app-shell--display">
        <header className="app-shell__header app-shell__header--display">
          <div className="app-shell__display-toolbar">
            <div>
              <p className="eyebrow">Display entrypoint</p>
              <h1>NikoF avatar display surface</h1>
            </div>
            <SurfaceModeSwitch
              surfaceMode={surfaceMode}
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
              <DevAnimationSwitcherPanel
                selectedOptionId={devDisplayAnimationOverride.optionId}
                backendAnimationId={backendAnimationId}
                onSelectOption={handleSelectDevDisplayAnimation}
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
              speechPlaybackStatusLabel={speechPlaybackStatusLabel}
            />
          </aside>
        </main>
      </div>
    );
  }

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
            surfaceMode={surfaceMode}
            controlSurfaceHref={controlSurfaceHref}
            displaySurfaceHref={displaySurfaceHref}
          />
      </header>

      <main className="app-shell__content app-shell__content--control">
        <div className="app-shell__sidebar">
          <CharacterCatalogPanel
            catalog={loadState.catalog}
            error={loadState.error}
            isLoading={loadState.status === "loading"}
            statusMessage={loadState.status === "ready" ? backendStatusMessage : null}
            selectedCharacterId={selectedCharacterId}
            onSelectCharacter={handleSelectCharacter}
          />
          <SpeechLifecyclePanel
            state={speechLifecycleState}
            snapshot={speechLifecycleSnapshot}
            message={speechLifecycleMessage}
            characterId={speechLifecycleCharacterId}
            canonicalTranscription={canonicalTranscription}
            canonicalSynthesis={canonicalSynthesis}
          />
        </div>
        <div className="app-shell__control-rail">
          <ControlSurfaceOperatorCommandPanel
            selectedCharacter={selectedCharacter}
            onCommandPublished={handleCommandPublished}
          />
          <ControlSurfaceSummaryPanel
            selectedCharacter={selectedCharacter}
            backendStatusMessage={backendStatusMessage}
            backendSyncState={backendSyncState}
            speechLifecycleState={speechLifecycleState}
            speechLifecycleSnapshot={speechLifecycleSnapshot}
            speechPlaybackStatusLabel={speechPlaybackStatusLabel}
          />
        </div>
      </main>
    </div>
  );
}