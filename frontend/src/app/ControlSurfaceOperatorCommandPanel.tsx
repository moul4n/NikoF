import React, { useEffect, useRef, useState } from "react";
import {
  OPERATOR_COMMAND_ROUTE_PATH,
  OperatorCommandSubmitError,
  submitOperatorCommand
} from "../avatar/loaders/operatorCommand.js";
import type {
  BackendAssistantMessageDocument,
  BackendOperatorCommandResponseDocument,
  BackendOperatorCommandType,
  BackendSttTranscriptChunkDocument,
  BackendSpeechSynthesisDocument,
  CharacterCatalogEntry
} from "../shared/types/character";
import type { SpeechPlaybackState } from "./useSpeechPlaybackBridge";
import {
  describeSpeechLifecycleStateMessage,
  resolveSpeechLifecycleCharacterId,
  resolveSpeechLifecycleDeliveryLabel,
  type SpeechLifecycleLoadState
} from "./useSpeechLifecycleState.js";
import { describeAttentionStateLine, useAttentionState } from "./useAttentionState.js";
import { describeSttStateLine, useSttState } from "./useSttState.js";
import { useAttentionCapture } from "../features/vision/useAttentionCapture.js";
import {
  formatPushToTalkBindingLabel,
  isEditableKeyboardTarget,
  isModifierOnlyKey,
  matchesPushToTalkBinding,
  normalizePushToTalkBinding,
  readPersistedPushToTalkBinding,
  writePersistedPushToTalkBinding,
  type PushToTalkBinding
} from "./pushToTalkBinding.js";

type OperatorCommandSubmissionState = {
  status: "idle" | "submitting" | "ready" | "error";
  activeCommandType: BackendOperatorCommandType | null;
  submittedText: string | null;
  response: BackendOperatorCommandResponseDocument | null;
  error: string | null;
};

interface ControlSurfaceOperatorCommandPanelProps {
  selectedCharacter: CharacterCatalogEntry | null;
  speechLifecycleState: SpeechLifecycleLoadState;
  speechPlaybackStatus: SpeechPlaybackState;
  onCommandPublished: (response: BackendOperatorCommandResponseDocument | null) => void;
}

type SpeechLifecycleSnapshot = SpeechLifecycleLoadState["snapshot"];

function formatTimelinePercent(value: number, totalMs: number): string {
  if (!(totalMs > 0)) {
    return "0%";
  }

  const normalized = Math.min(100, Math.max(0, (value / totalMs) * 100));
  return `${normalized.toFixed(2)}%`;
}

function formatCueWindow(startMs: number, endMs: number): string {
  return `${(startMs / 1000).toFixed(2)}s - ${(endMs / 1000).toFixed(2)}s`;
}

function getOperatorCommandLabel(commandType: BackendOperatorCommandType | null): string {
  if (commandType === "text_question") {
    return "Text question";
  }

  if (commandType === "tts_preview") {
    return "TTS preview";
  }

  return "Operator command";
}

function describeOperatorCommandState(state: OperatorCommandSubmissionState): string {
  if (state.status === "submitting") {
    return `${getOperatorCommandLabel(state.activeCommandType)} is being posted to ${OPERATOR_COMMAND_ROUTE_PATH}. The control surface is waiting for the canonical speech.lifecycle read model to catch up.`;
  }

  if (state.status === "error") {
    return state.error ?? "Backend operator-command request failed.";
  }

  return `Use these forms to publish backend-owned text-question and TTS-preview commands through ${OPERATOR_COMMAND_ROUTE_PATH} without creating a local display shortcut.`;
}

function getAssistantReply(
  response: BackendOperatorCommandResponseDocument | null
): BackendAssistantMessageDocument | null {
  if (!response || response.command_type !== "text_question") {
    return null;
  }

  return response.session_event.assistant ?? response.speech_lifecycle_events[0]?.event.assistant ?? null;
}

function getSynthesisPreview(
  response: BackendOperatorCommandResponseDocument | null
): BackendSpeechSynthesisDocument | null {
  if (!response) {
    return null;
  }

  return (
    response.session_event.synthesis ??
    response.speech_lifecycle_events.find((envelope) => envelope.event.event_type === "speech.synthesis")?.event.synthesis ??
    null
  );
}

function getTextQuestionVoiceDispatch(
  response: BackendOperatorCommandResponseDocument | null
): BackendSpeechSynthesisDocument | null {
  if (!response || response.command_type !== "text_question") {
    return null;
  }

  return response.session_event.synthesis ?? null;
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
  snapshot: SpeechLifecycleSnapshot,
  response: BackendOperatorCommandResponseDocument | null
): boolean {
  const snapshotCursor = parseSpeechLifecycleCursor(snapshot?.nextCursor ?? null);
  const responseCursor = parseSpeechLifecycleCursor(response?.next_speech_cursor ?? null);

  if (!snapshotCursor || !responseCursor) {
    return false;
  }

  return snapshotCursor.sessionId === responseCursor.sessionId && snapshotCursor.sequence >= responseCursor.sequence;
}

function resolvePreferredAssistantReply(
  response: BackendOperatorCommandResponseDocument | null,
  snapshot: SpeechLifecycleSnapshot
): BackendAssistantMessageDocument | null {
  const canonicalAssistantReply = snapshot?.canonicalAssistantMessageEvent?.assistant ?? null;

  if (response && !hasSpeechLifecycleSnapshotCaughtUp(snapshot, response)) {
    return getAssistantReply(response) ?? canonicalAssistantReply;
  }

  return canonicalAssistantReply ?? getAssistantReply(response);
}

function resolvePreferredSynthesisPreview(
  response: BackendOperatorCommandResponseDocument | null,
  snapshot: SpeechLifecycleSnapshot
): BackendSpeechSynthesisDocument | null {
  const canonicalSynthesis = snapshot?.canonicalSpeechSynthesisEvent?.synthesis ?? null;

  if (response && !hasSpeechLifecycleSnapshotCaughtUp(snapshot, response)) {
    return getSynthesisPreview(response) ?? canonicalSynthesis;
  }

  return canonicalSynthesis ?? getSynthesisPreview(response);
}

function describeSynthesisTiming(synthesis: BackendSpeechSynthesisDocument | null): string {
  const durationMs = synthesis?.timing?.utterance_duration_ms;

  if (typeof durationMs !== "number") {
    return "timing unavailable";
  }

  return `${(durationMs / 1000).toFixed(2)}s`;
}

function describeSpeechPlaybackStatus(playback: SpeechPlaybackState): string {
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

function describeSpeechPlaybackTransport(playback: SpeechPlaybackState): string {
  if (playback.transport === "audio_reference") {
    return playback.audioSource ? "browser-safe audio reference" : "audio reference pending browser-safe route";
  }

  if (playback.transport === "timing_window") {
    return "canonical timing metadata";
  }

  return "none";
}

function formatSttChunkTimestamp(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "time unavailable";
  }

  return new Date(value * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function describeSttChunkDispatchState(chunk: BackendSttTranscriptChunkDocument): string {
  if (chunk.dispatch_state === "submitted") {
    return `sent to ${chunk.dispatch_target ?? "llm"}`;
  }

  if (chunk.dispatch_state === "stub-recorded") {
    return "stored for stub dispatch";
  }

  if (chunk.dispatch_state === "queued") {
    return `queued for ${chunk.dispatch_target ?? "llm"}`;
  }

  if (chunk.dispatch_state === "filtered") {
    return "kept as debug-only";
  }

  if (chunk.dispatch_state === "error") {
    return "dispatch error";
  }

  return chunk.dispatch_state;
}

function describeBackendCanonicalBundleReadiness(playback: SpeechPlaybackState): string | null {
  const bundle = playback.lastBundle;
  if (!bundle) {
    return null;
  }

  const hasAudio = bundle.audioSource !== null;
  const hasTimingWindow = typeof bundle.utteranceDurationMs === "number" && bundle.utteranceDurationMs > 0;
  const hasMouthCueTracks = (bundle.lipSync?.mouth_cue_tracks.length ?? 0) > 0;
  const hasVisemeSlots = bundle.visemeSlots.length > 0;

  if (hasAudio && hasMouthCueTracks) {
    return "Backend canonical bundle is live-test ready for browser audio plus generated mouth cue tracks.";
  }

  if (hasAudio && hasVisemeSlots) {
    return "Backend canonical bundle is live-test ready for browser audio plus raw viseme timing.";
  }

  if (hasAudio && hasTimingWindow) {
    return "Backend canonical bundle has browser-playable audio, but no phoneme or viseme mouth payload was published.";
  }

  if (hasTimingWindow && (hasMouthCueTracks || hasVisemeSlots)) {
    return "Backend canonical bundle can drive timing-based mouth sync, but no browser-playable audio reference was published.";
  }

  if (hasTimingWindow) {
    return "Backend canonical bundle only exposes a timing window right now.";
  }

  return "Backend canonical bundle is incomplete: no playable audio and no timing metadata were published.";
}

function renderSpeechBundleTimeline(playback: SpeechPlaybackState): JSX.Element | null {
  const bundle = playback.lastBundle;
  const lipSync = bundle?.lipSync;
  const totalMs = bundle?.utteranceDurationMs ?? null;

  if (!bundle || !lipSync || lipSync.mouth_cue_tracks.length === 0 || typeof totalMs !== "number" || totalMs <= 0) {
    return null;
  }

  return (
    <section className="operator-panel__timeline" aria-labelledby="operator-speech-bundle-timeline-title">
      <div className="operator-panel__timeline-header">
        <div>
          <p className="eyebrow">Speech bundle</p>
          <h3 id="operator-speech-bundle-timeline-title">Lip-sync track timeline</h3>
        </div>
        <p className="operator-panel__timeline-meta">{(totalMs / 1000).toFixed(2)}s total</p>
      </div>

      {lipSync.mouth_cue_tracks.map((track) => {
        const isDefaultTrack = track.track_id === playback.lipSyncDefaultTrackId;
        return (
          <article
            key={track.track_id}
            className={isDefaultTrack ? "operator-panel__timeline-track operator-panel__timeline-track--default" : "operator-panel__timeline-track"}
          >
            <div className="operator-panel__timeline-track-header">
              <div>
                <p className="operator-panel__timeline-track-title">{track.track_id}</p>
                <p className="operator-panel__timeline-track-subtitle">{track.cue_namespace}</p>
              </div>
              <p className="operator-panel__timeline-track-meta">
                {isDefaultTrack ? "default" : "optional"} · {track.cues.length} cues
              </p>
            </div>

            <div className="operator-panel__timeline-lane" role="img" aria-label={`${track.track_id} cue timeline`}>
              {track.cues.map((cue, cueIndex) => (
                <span
                  key={`${track.track_id}:${cue.cue}:${cue.start_ms}:${cueIndex}`}
                  className="operator-panel__timeline-segment"
                  style={{
                    left: formatTimelinePercent(cue.start_ms, totalMs),
                    width: formatTimelinePercent(Math.max(0, cue.end_ms - cue.start_ms), totalMs)
                  }}
                  title={`${cue.cue} · ${formatCueWindow(cue.start_ms, cue.end_ms)}`}
                >
                  <span className="operator-panel__timeline-segment-label">{cue.cue}</span>
                </span>
              ))}
            </div>

            <div className="operator-panel__timeline-cues">
              {track.cues.slice(0, 10).map((cue, cueIndex) => (
                <span key={`${track.track_id}:chip:${cue.cue}:${cue.start_ms}:${cueIndex}`} className="operator-panel__timeline-chip">
                  {cue.cue} · {formatCueWindow(cue.start_ms, cue.end_ms)}
                </span>
              ))}
              {track.cues.length > 10 ? (
                <span className="operator-panel__timeline-chip operator-panel__timeline-chip--muted">
                  +{track.cues.length - 10} more
                </span>
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function resolveCanonicalCatchUpLabel(
  response: BackendOperatorCommandResponseDocument | null,
  speechLifecycleState: SpeechLifecycleLoadState
): string {
  if (!response) {
    return speechLifecycleState.snapshot ? "tracking canonical lifecycle" : "No pending command";
  }

  if (hasSpeechLifecycleSnapshotCaughtUp(speechLifecycleState.snapshot, response)) {
    return "confirmed in canonical speech.lifecycle";
  }

  if (speechLifecycleState.status === "offline") {
    return "waiting for lifecycle recovery";
  }

  if (!speechLifecycleState.snapshot) {
    return "awaiting first lifecycle snapshot";
  }

  return `waiting for ${response.next_speech_cursor}`;
}

function resolveOperatorResultSourceLabel(
  response: BackendOperatorCommandResponseDocument | null,
  speechLifecycleState: SpeechLifecycleLoadState
): string {
  if (response && !hasSpeechLifecycleSnapshotCaughtUp(speechLifecycleState.snapshot, response)) {
    return "accepted operator response";
  }

  if (speechLifecycleState.snapshot) {
    return "canonical speech.lifecycle";
  }

  if (response) {
    return "accepted operator response";
  }

  return "Awaiting backend result";
}

function describeOperatorPreviewState(
  state: OperatorCommandSubmissionState,
  speechLifecycleState: SpeechLifecycleLoadState
): string {
  if (state.status !== "ready" || !state.response) {
    return describeOperatorCommandState(state);
  }

  if (hasSpeechLifecycleSnapshotCaughtUp(speechLifecycleState.snapshot, state.response)) {
    return `${getOperatorCommandLabel(state.response.command_type)} is confirmed on ${resolveSpeechLifecycleDeliveryLabel(speechLifecycleState)}.`;
  }

  return `${getOperatorCommandLabel(state.response.command_type)} was accepted for ${state.response.character_id}. Waiting for ${state.response.next_speech_cursor} on the canonical speech.lifecycle feed.`;
}

function resolveOperatorFeedbackTone(
  state: OperatorCommandSubmissionState
): "default" | "pending" | "error" {
  if (state.status === "submitting") {
    return "pending";
  }

  if (state.status === "error") {
    return "error";
  }

  return "default";
}

function buildFeedbackClassName(
  baseClassName: "surface-panel__message" | "surface-panel__summary",
  tone: "default" | "pending" | "error"
): string {
  if (tone === "default") {
    return baseClassName;
  }

  return `${baseClassName} ${baseClassName}--${tone}`;
}

export function ControlSurfaceOperatorCommandPanel({
  selectedCharacter,
  speechLifecycleState,
  speechPlaybackStatus,
  onCommandPublished
}: ControlSurfaceOperatorCommandPanelProps): JSX.Element {
  const {
    state: attentionState,
    setSelectedDevice: setSelectedAttentionDevice,
    setEnabled: setAttentionEnabled,
    setTracking: setAttentionTracking,
    setShowTrackingDebugMarker,
  } = useAttentionState();
  const { state: sttState, setSelectedDevice, setListening } = useSttState();
  const [operatorCommandLocale, setOperatorCommandLocale] = useState("en-US");
  const [textQuestionDraft, setTextQuestionDraft] = useState("");
  const [ttsPreviewDraft, setTtsPreviewDraft] = useState("");
  const [pushToTalkBinding, setPushToTalkBinding] = useState<PushToTalkBinding>(() => readPersistedPushToTalkBinding());
  const [isCapturingPushToTalkKey, setIsCapturingPushToTalkKey] = useState(false);
  const [isPushToTalkActive, setIsPushToTalkActive] = useState(false);
  const [operatorCommandState, setOperatorCommandState] = useState<OperatorCommandSubmissionState>({
    status: "idle",
    activeCommandType: null,
    submittedText: null,
    response: null,
    error: null
  });
  const pushToTalkHeldRef = useRef(false);
  const pushToTalkStartedListeningRef = useRef(false);

  function handleOperatorCommandSubmit(commandType: BackendOperatorCommandType, text: string): void {
    const locale = operatorCommandLocale.trim() || "en-US";

    onCommandPublished(null);

    setOperatorCommandState((currentState) => ({
      status: "submitting",
      activeCommandType: commandType,
      submittedText: text,
      response: currentState.response,
      error: null
    }));

    void submitOperatorCommand({
      command_type: commandType,
      text,
      locale
    })
      .then((response) => {
        if (commandType === "text_question") {
          setTextQuestionDraft("");
        }

        if (commandType === "tts_preview") {
          setTtsPreviewDraft("");
        }

        setOperatorCommandState({
          status: "ready",
          activeCommandType: commandType,
          submittedText: text,
          response,
          error: null
        });
        onCommandPublished(response);
      })
      .catch((error: unknown) => {
        const errorMessage =
          error instanceof OperatorCommandSubmitError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Backend operator-command request failed.";

        setOperatorCommandState((currentState) => ({
          status: "error",
          activeCommandType: commandType,
          submittedText: currentState.submittedText,
          response: currentState.response,
          error: errorMessage
        }));
      });
  }

  function handleSubmitTextQuestion(event: { preventDefault(): void }): void {
    event.preventDefault();
    handleOperatorCommandSubmit("text_question", textQuestionDraft);
  }

  function handleSubmitTtsPreview(event: { preventDefault(): void }): void {
    event.preventDefault();
    handleOperatorCommandSubmit("tts_preview", ttsPreviewDraft);
  }

  const speechLifecycleSnapshot = speechLifecycleState.snapshot;
  const lifecycleMessage = describeSpeechLifecycleStateMessage(speechLifecycleState);
  const isSubmitting = operatorCommandState.status === "submitting";
  const isBlockingTtsPreviewResult =
    operatorCommandState.activeCommandType === "tts_preview" &&
    (operatorCommandState.status === "submitting" || operatorCommandState.status === "error");
  const isBlockingTextQuestionResult =
    operatorCommandState.activeCommandType === "text_question" &&
    (operatorCommandState.status === "submitting" || operatorCommandState.status === "error");
  const lastPublishedEvent =
    (isSubmitting ? "operator-command.pending" : null) ??
    (operatorCommandState.status === "error" ? "operator-command.error" : null) ??
    speechLifecycleSnapshot?.latestEvent?.event_type ??
    operatorCommandState.response?.speech_lifecycle_events.at(-1)?.event.event_type ??
    "No command submitted yet";
  const assistantReply = isBlockingTextQuestionResult
    ? null
    : resolvePreferredAssistantReply(operatorCommandState.response, speechLifecycleSnapshot);
  const textQuestionVoiceDispatch = isBlockingTextQuestionResult ? null : getTextQuestionVoiceDispatch(operatorCommandState.response);
  const synthesisPreview = isBlockingTtsPreviewResult
    ? null
    : resolvePreferredSynthesisPreview(operatorCommandState.response, speechLifecycleSnapshot);
  const speechLifecycleCharacterId = resolveSpeechLifecycleCharacterId(speechLifecycleSnapshot);
  const canonicalCatchUpLabel = isSubmitting
    ? "awaiting operator response"
    : operatorCommandState.status === "error"
      ? "request failed before response publication"
    : resolveCanonicalCatchUpLabel(operatorCommandState.response, speechLifecycleState);
  const resultSourceLabel = isSubmitting
    ? "pending operator request"
    : operatorCommandState.status === "error"
      ? "no accepted operator result"
    : resolveOperatorResultSourceLabel(operatorCommandState.response, speechLifecycleState);
  const operatorPreviewStateMessage = describeOperatorPreviewState(operatorCommandState, speechLifecycleState);
  const operatorFeedbackTone = resolveOperatorFeedbackTone(operatorCommandState);
  const operatorPreviewMessageClassName = buildFeedbackClassName("surface-panel__message", operatorFeedbackTone);
  const operatorPreviewSummaryClassName = buildFeedbackClassName("surface-panel__summary", operatorFeedbackTone);
  const submitTextQuestionDisabled = isSubmitting || textQuestionDraft.trim().length === 0;
  const submitTtsPreviewDisabled = isSubmitting || ttsPreviewDraft.trim().length === 0;
  const canReplayLastBundle =
    speechPlaybackStatus.lastBundle !== null &&
    (speechPlaybackStatus.lastBundle.audioSource !== null ||
      (typeof speechPlaybackStatus.lastBundle.utteranceDurationMs === "number" &&
        speechPlaybackStatus.lastBundle.utteranceDurationMs > 0));
  const latestTextQuestion = operatorCommandState.submittedText?.trim() ?? "";
  const textQuestionRelaySourceLabel = isBlockingTextQuestionResult
    ? isSubmitting
      ? "pending operator request"
      : "request failed"
    : assistantReply
      ? resultSourceLabel
      : "Awaiting backend result";
  const textQuestionRelayStatusLabel = isBlockingTextQuestionResult
    ? isSubmitting
      ? "Submitting"
      : "Error"
    : assistantReply?.status ?? "Idle";
  const sttSnapshot = sttState.snapshot;
  const attentionSnapshot = attentionState.snapshot;
  const attentionStatusLine = describeAttentionStateLine(attentionState);
  const sttStatusLine = describeSttStateLine(sttState);
  const sttTranscriptChunks = sttSnapshot?.transcript_chunks ?? [];
  const sttLatestTranscript = sttTranscriptChunks[0]?.transcript ?? sttSnapshot?.latest_confirmed_text ?? "Awaiting a queued transcript from the STT sidecar.";
  const sttListeningButtonLabel = sttSnapshot?.listening ? "Stop listening" : "Start listening";
  const sttControlsDisabled = sttState.action !== "idle" || sttState.status === "loading";
  const sttPushToTalkDisabled = sttState.action === "device" || sttState.status === "loading" || !sttSnapshot?.available;
  const pushToTalkKeyLabel = formatPushToTalkBindingLabel(pushToTalkBinding);
  const pushToTalkButtonLabel = isCapturingPushToTalkKey ? "Press a key..." : `Push-to-talk key: ${pushToTalkKeyLabel}`;
  const pushToTalkStatusLine = isCapturingPushToTalkKey
    ? "Press any non-modifier key to bind push-to-talk. Press Escape to cancel."
    : isPushToTalkActive
      ? `Holding ${pushToTalkKeyLabel} keeps STT capture open until release.`
      : `Hold ${pushToTalkKeyLabel} anywhere on the control surface to talk. Focused text fields are ignored.`;
  const attentionEnabledButtonLabel = attentionSnapshot?.enabled ? "Disable attention" : "Enable attention";
  const attentionTrackingButtonLabel = attentionSnapshot?.tracking ? "Stop tracking" : "Start tracking";
  const attentionControlsDisabled = attentionState.action !== "idle" || attentionState.status === "loading";
  const attentionSubject = attentionSnapshot?.subject ?? null;
  const attentionCaptureState = useAttentionCapture({
    enabled: attentionSnapshot?.enabled ?? false,
    tracking: attentionSnapshot?.tracking ?? false,
    selectedDeviceId: attentionSnapshot?.selected_device_id ?? null,
    selectedDeviceLabel: attentionSnapshot?.selected_device_label ?? null,
  });
  const attentionDevices = attentionCaptureState.devices.length > 0 ? attentionCaptureState.devices : attentionState.devices;

  useEffect(() => {
    writePersistedPushToTalkBinding(pushToTalkBinding);
  }, [pushToTalkBinding]);

  useEffect(() => {
    function releasePushToTalk(): void {
      if (!pushToTalkHeldRef.current) {
        return;
      }

      pushToTalkHeldRef.current = false;
      setIsPushToTalkActive(false);

      const shouldStopListening = pushToTalkStartedListeningRef.current;
      pushToTalkStartedListeningRef.current = false;
      if (shouldStopListening) {
        void setListening(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (isCapturingPushToTalkKey) {
        if (event.repeat) {
          return;
        }

        event.preventDefault();
        if (event.key === "Escape") {
          setIsCapturingPushToTalkKey(false);
          return;
        }

        if (isModifierOnlyKey(event.key)) {
          return;
        }

        setPushToTalkBinding(
          normalizePushToTalkBinding({
            code: event.code || null,
            key: event.key || null
          })
        );
        setIsCapturingPushToTalkKey(false);
        return;
      }

      if (!matchesPushToTalkBinding(event, pushToTalkBinding) || isEditableKeyboardTarget(event.target)) {
        return;
      }

      event.preventDefault();
      if (event.repeat || pushToTalkHeldRef.current || sttPushToTalkDisabled) {
        return;
      }

      pushToTalkHeldRef.current = true;
      setIsPushToTalkActive(true);
      pushToTalkStartedListeningRef.current = !(sttSnapshot?.listening ?? false);
      if (pushToTalkStartedListeningRef.current) {
        void setListening(true);
      }
    }

    function handleKeyUp(event: KeyboardEvent): void {
      if (isCapturingPushToTalkKey || !matchesPushToTalkBinding(event, pushToTalkBinding)) {
        return;
      }

      event.preventDefault();
      releasePushToTalk();
    }

    function handleWindowBlur(): void {
      setIsCapturingPushToTalkKey(false);
      releasePushToTalk();
    }

    function handleVisibilityChange(): void {
      if (!document.hidden) {
        return;
      }

      setIsCapturingPushToTalkKey(false);
      releasePushToTalk();
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isCapturingPushToTalkKey, pushToTalkBinding, setListening, sttPushToTalkDisabled, sttSnapshot?.listening]);

  function formatAttentionCoordinate(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "n/a";
    }

    return value.toFixed(2);
  }

  function handleSelectedDeviceChange(event: { target: { value: string } }): void {
    const nextDeviceId = event.target.value.trim() || null;
    void setSelectedDevice(nextDeviceId);
  }

  function handleSelectedAttentionDeviceChange(event: { target: { value: string } }): void {
    const nextDeviceId = event.target.value.trim() || null;
    const nextDevice = attentionDevices.find((device) => {
      if ("device_id" in device) {
        return device.device_id === nextDeviceId;
      }

      return device.deviceId === nextDeviceId;
    });
    const nextDeviceLabel = nextDevice ? ("label" in nextDevice ? nextDevice.label : null) : null;
    void setSelectedAttentionDevice({ deviceId: nextDeviceId, deviceLabel: nextDeviceLabel });
  }

  function handleListeningToggle(): void {
    void setListening(!(sttSnapshot?.listening ?? false));
  }

  function handleAttentionEnabledToggle(): void {
    void setAttentionEnabled(!(attentionSnapshot?.enabled ?? false));
  }

  function handleAttentionTrackingToggle(): void {
    void setAttentionTracking(!(attentionSnapshot?.tracking ?? false));
  }

  function handleAttentionDebugMarkerToggle(event: { target: { checked: boolean } }): void {
    setShowTrackingDebugMarker(event.target.checked);
  }

  return (
    <section className="surface-panel operator-panel" aria-labelledby="operator-command-panel-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Operator commands</p>
          <h2 id="operator-command-panel-title">Backend command seam</h2>
        </div>
      </div>

      <p
        className={operatorPreviewMessageClassName}
        role={operatorFeedbackTone === "error" ? "alert" : "status"}
        aria-live="polite"
      >
        {operatorPreviewStateMessage}
      </p>
      {lifecycleMessage ? <p className={operatorPreviewSummaryClassName}>{lifecycleMessage}</p> : null}

      <dl className="surface-panel__facts">
        <div>
          <dt>Target character</dt>
          <dd>
            {speechLifecycleCharacterId ??
              operatorCommandState.response?.character_id ??
              selectedCharacter?.summary.characterId ??
              "Awaiting backend confirmation"}
          </dd>
        </div>
        <div>
          <dt>Write path</dt>
          <dd>{OPERATOR_COMMAND_ROUTE_PATH}</dd>
        </div>
        <div>
          <dt>Locale</dt>
          <dd>{operatorCommandLocale.trim() || "en-US"}</dd>
        </div>
        <div>
          <dt>Speech delivery</dt>
          <dd>{resolveSpeechLifecycleDeliveryLabel(speechLifecycleState)}</dd>
        </div>
        <div>
          <dt>Last published event</dt>
          <dd>{lastPublishedEvent}</dd>
        </div>
        <div>
          <dt>Next speech cursor</dt>
          <dd>{speechLifecycleSnapshot?.nextCursor ?? operatorCommandState.response?.next_speech_cursor ?? "Unchanged"}</dd>
        </div>
        <div>
          <dt>Lifecycle catch-up</dt>
          <dd>{canonicalCatchUpLabel}</dd>
        </div>
        <div>
          <dt>Result source</dt>
          <dd>{resultSourceLabel}</dd>
        </div>
        <div>
          <dt>Assistant status</dt>
          <dd>{assistantReply?.status ?? "Awaiting assistant reply"}</dd>
        </div>
        <div>
          <dt>Synthesis status</dt>
          <dd>{synthesisPreview?.status ?? "Awaiting synthesis result"}</dd>
        </div>
        <div>
          <dt>Playback bridge</dt>
          <dd>{describeSpeechPlaybackStatus(speechPlaybackStatus)}</dd>
        </div>
        <div>
          <dt>Playback transport</dt>
          <dd>{describeSpeechPlaybackTransport(speechPlaybackStatus)}</dd>
        </div>
        <div>
          <dt>STT state</dt>
          <dd>{sttSnapshot?.state ?? sttState.status}</dd>
        </div>
        <div>
          <dt>STT device</dt>
          <dd>{sttSnapshot?.selected_device_label ?? "Awaiting backend device list"}</dd>
        </div>
        <div>
          <dt>Attention state</dt>
          <dd>{attentionSnapshot?.state ?? attentionState.status}</dd>
        </div>
        <div>
          <dt>Camera source</dt>
          <dd>{attentionSnapshot?.selected_device_label ?? "Awaiting backend camera list"}</dd>
        </div>
      </dl>

      <section className="operator-panel__stt" aria-labelledby="operator-attention-title">
        <div className="operator-panel__stt-header">
          <div>
            <p className="eyebrow">Camera attention</p>
            <h3 id="operator-attention-title">Attention tracking scaffold</h3>
          </div>
          <p className="operator-panel__stt-status">{attentionStatusLine}</p>
        </div>

        <label className="operator-panel__field" htmlFor="operator-attention-device">
          <span className="operator-panel__field-label">Camera source</span>
          <select
            id="operator-attention-device"
            className="operator-panel__input"
            value={attentionSnapshot?.selected_device_id ?? ""}
            onChange={handleSelectedAttentionDeviceChange}
            disabled={attentionControlsDisabled}
          >
            {attentionDevices.length === 0 ? <option value="">No browser camera sources detected</option> : null}
            {attentionDevices.map((device) => (
              <option key={("device_id" in device ? device.device_id : device.deviceId)} value={"device_id" in device ? device.device_id : device.deviceId}>
                {device.label}
                {device.default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="operator-panel__actions">
          <button
            className="operator-panel__button"
            type="button"
            onClick={handleAttentionEnabledToggle}
            disabled={attentionControlsDisabled || !attentionSnapshot?.available}
          >
            {attentionState.action === "enabled" ? "Updating attention state..." : attentionEnabledButtonLabel}
          </button>
          <button
            className="operator-panel__button"
            type="button"
            onClick={handleAttentionTrackingToggle}
            disabled={attentionControlsDisabled || !attentionSnapshot?.enabled}
          >
            {attentionState.action === "tracking" ? "Updating tracking state..." : attentionTrackingButtonLabel}
          </button>
        </div>

        <label className="operator-panel__checkbox" htmlFor="operator-attention-debug-marker">
          <input
            id="operator-attention-debug-marker"
            type="checkbox"
            checked={attentionState.showTrackingDebugMarker}
            onChange={handleAttentionDebugMarkerToggle}
          />
          <span>Show display tracking dot</span>
        </label>

        <div className="operator-panel__stt-transcript" aria-live="polite">
          <div className="operator-panel__stt-transcript-header">
            <p className="operator-panel__stt-transcript-label">Attention snapshot</p>
            <p className="operator-panel__stt-transcript-meta">
              {attentionSubject ? `${((attentionSnapshot?.confidence ?? 0) * 100).toFixed(0)}% confidence` : "No tracked subject"}
            </p>
          </div>
          <p className="operator-panel__stt-transcript-text">
            {attentionSubject
              ? `x ${formatAttentionCoordinate(attentionSubject.normalized_x)} · y ${formatAttentionCoordinate(attentionSubject.normalized_y)}`
              : "Waiting for normalized attention observations from the live browser camera capture path."}
          </p>
          <div className="operator-panel__stt-log" role="list" aria-label="Current attention metrics">
            <article className="operator-panel__stt-log-entry" role="listitem">
              <div className="operator-panel__stt-log-entry-header">
                <p className="operator-panel__stt-log-entry-title">Backend attention state</p>
                <p className="operator-panel__stt-log-entry-meta">{attentionSnapshot?.fps_target ?? 8} fps target</p>
              </div>
              <p className="operator-panel__stt-log-entry-text">
                Enabled: {attentionSnapshot?.enabled ? "yes" : "no"} · Tracking: {attentionSnapshot?.tracking ? "yes" : "no"}
              </p>
              <p className="operator-panel__stt-log-entry-detail">
                Frame: {attentionSnapshot?.frame_width ?? 320} x {attentionSnapshot?.frame_height ?? 240}
              </p>
            </article>
          </div>
        </div>

        <p className="operator-panel__hint">
          Browser camera capture now runs in this operator surface, while device selection, enabled state, tracking state, and the canonical attention snapshot stay backend-owned.
        </p>
        {attentionCaptureState.message ? <p className="surface-panel__summary">{attentionCaptureState.message}</p> : null}
        {attentionState.message ? <p className="surface-panel__summary">{attentionState.message}</p> : null}
      </section>

      <section className="operator-panel__stt" aria-labelledby="operator-stt-title">
        <div className="operator-panel__stt-header">
          <div>
            <p className="eyebrow">Speech-to-text</p>
            <h3 id="operator-stt-title">Hot mic sidecar</h3>
          </div>
          <p className="operator-panel__stt-status">{sttStatusLine}</p>
        </div>

        <label className="operator-panel__field" htmlFor="operator-stt-device">
          <span className="operator-panel__field-label">Audio input</span>
          <select
            id="operator-stt-device"
            className="operator-panel__input"
            value={sttSnapshot?.selected_device_id ?? ""}
            onChange={handleSelectedDeviceChange}
            disabled={sttControlsDisabled}
          >
            {sttState.devices.length === 0 ? <option value="">No backend input devices detected</option> : null}
            {sttState.devices.map((device) => (
              <option key={device.device_id} value={device.device_id}>
                {device.label}
                {device.default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="operator-panel__actions">
          <button
            className="operator-panel__button"
            type="button"
            onClick={handleListeningToggle}
            disabled={sttControlsDisabled || !sttSnapshot?.available}
          >
            {sttState.action === "listening" ? "Updating microphone state..." : sttListeningButtonLabel}
          </button>
          <button
            className={isCapturingPushToTalkKey || isPushToTalkActive ? "operator-panel__button operator-panel__button--active" : "operator-panel__button"}
            type="button"
            onClick={() => {
              setIsCapturingPushToTalkKey((currentValue) => !currentValue);
            }}
            aria-pressed={isCapturingPushToTalkKey}
          >
            {pushToTalkButtonLabel}
          </button>
        </div>

        <p className="operator-panel__hint">{pushToTalkStatusLine}</p>

        <div className="operator-panel__stt-transcript" aria-live="polite">
          <div className="operator-panel__stt-transcript-header">
            <p className="operator-panel__stt-transcript-label">STT output window</p>
            <p className="operator-panel__stt-transcript-meta">{sttTranscriptChunks.length} stored chunks</p>
          </div>
          <p className="operator-panel__stt-transcript-text">{sttLatestTranscript}</p>
          <div className="operator-panel__stt-log" role="list" aria-label="Recent STT transcript chunks">
            {sttTranscriptChunks.length === 0 ? (
              <p className="operator-panel__stt-log-empty">Waiting for confirmed speech chunks from the hot-mic sidecar.</p>
            ) : (
              sttTranscriptChunks.map((chunk) => (
                <article key={chunk.chunk_id} className="operator-panel__stt-log-entry" role="listitem">
                  <div className="operator-panel__stt-log-entry-header">
                    <p className="operator-panel__stt-log-entry-title">{describeSttChunkDispatchState(chunk)}</p>
                    <p className="operator-panel__stt-log-entry-meta">
                      {formatSttChunkTimestamp(chunk.captured_at)} · {(chunk.duration_ms / 1000).toFixed(2)}s
                      {typeof chunk.confidence === "number" ? ` · ${(chunk.confidence * 100).toFixed(0)}% conf` : ""}
                    </p>
                  </div>
                  <p className="operator-panel__stt-log-entry-text">{chunk.transcript}</p>
                  {chunk.dispatch_detail ? (
                    <p className="operator-panel__stt-log-entry-detail">{chunk.dispatch_detail}</p>
                  ) : null}
                </article>
              ))
            )}
          </div>
        </div>

        <p className="operator-panel__hint">
          Browser controls stay backend-owned here: input selection updates the sidecar through the backend, confirmed chunks are stored in the backend STT buffer for debugging, and accepted chunks are marked for stub or live downstream dispatch.
        </p>
        {sttState.message ? <p className="surface-panel__summary">{sttState.message}</p> : null}
      </section>

      {synthesisPreview ? <p className="surface-panel__message">{synthesisPreview.text}</p> : null}
      {synthesisPreview ? (
        <p className="surface-panel__summary">
          {synthesisPreview.profile_id} in {synthesisPreview.locale} · {describeSynthesisTiming(synthesisPreview)} · {synthesisPreview.audio_reference ?? "audio reference pending"}
        </p>
      ) : null}
      {isBlockingTtsPreviewResult && operatorCommandState.submittedText ? (
        <p className="surface-panel__message">{operatorCommandState.submittedText}</p>
      ) : null}
      {isBlockingTtsPreviewResult ? (
        <p
          className={buildFeedbackClassName(
            "surface-panel__summary",
            isSubmitting ? "pending" : "error"
          )}
        >
          {isSubmitting ? "Waiting for the backend TTS preview response." : "The control surface did not receive an accepted backend TTS preview response, so no new synthesis result is available here yet."}
        </p>
      ) : null}
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
      {speechPlaybackStatus.lastBundle ? (
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
      {speechPlaybackStatus.lastBundle ? (
        <p className="surface-panel__summary">
          Backend canonical bundle · default track {speechPlaybackStatus.lipSyncDefaultTrackId ?? "none"} · tracks {speechPlaybackStatus.lipSyncTrackIds.join(", ") || "none"} · source {speechPlaybackStatus.lipSyncTimingSource ?? "unspecified"}
          {speechPlaybackStatus.lipSyncSourceSlotType ? ` / ${speechPlaybackStatus.lipSyncSourceSlotType}` : ""}
        </p>
      ) : null}
      {describeBackendCanonicalBundleReadiness(speechPlaybackStatus) ? (
        <p className="surface-panel__summary">{describeBackendCanonicalBundleReadiness(speechPlaybackStatus)}</p>
      ) : null}
      {renderSpeechBundleTimeline(speechPlaybackStatus)}

      <label className="operator-panel__field" htmlFor="operator-command-locale">
        <span className="operator-panel__field-label">Command locale</span>
        <input
          id="operator-command-locale"
          className="operator-panel__input"
          type="text"
          value={operatorCommandLocale}
          onChange={(event: { target: { value: string } }) => setOperatorCommandLocale(event.target.value)}
          spellCheck={false}
        />
      </label>

      <div className="operator-panel__forms">
        <form className="operator-panel__form" onSubmit={handleSubmitTextQuestion}>
          <label className="operator-panel__field" htmlFor="operator-text-question">
            <span className="operator-panel__field-label">Text question</span>
            <textarea
              id="operator-text-question"
              className="operator-panel__textarea"
              rows={4}
              value={textQuestionDraft}
              onChange={(event: { target: { value: string } }) => setTextQuestionDraft(event.target.value)}
              placeholder="Ask a question without going through STT."
            />
          </label>
          <p className="operator-panel__hint">
            Posts only to {OPERATOR_COMMAND_ROUTE_PATH} as a text_question request, then waits for the canonical assistant and synthesis events to land on speech.lifecycle.
          </p>
          <div className="operator-panel__actions">
            <button className="operator-panel__button" type="submit" disabled={submitTextQuestionDisabled}>
              Send text question
            </button>
          </div>

          <div className="operator-panel__result" aria-live="polite">
            <div className="operator-panel__result-header">
              <p className="operator-panel__result-label">Backend text relay</p>
              <p className="operator-panel__result-meta">{textQuestionRelaySourceLabel}</p>
            </div>

            <div className="operator-panel__result-row">
              <p className="operator-panel__result-role">Question</p>
              <p className="operator-panel__result-text">
                {latestTextQuestion || "Send a text question to record the relayed prompt here."}
              </p>
            </div>

            <div className="operator-panel__result-row">
              <p className="operator-panel__result-role">Reply</p>
              <p className="operator-panel__result-text">
                {assistantReply?.text ??
                  (isSubmitting
                    ? "Waiting for the backend text-question response."
                    : operatorCommandState.status === "error"
                      ? operatorCommandState.error ?? "The backend text-question request failed before a new reply was published."
                      : "Awaiting backend assistant output.")}
              </p>
            </div>

            <p className="operator-panel__result-detail">
              Status: {textQuestionRelayStatusLabel}
              {assistantReply ? ` · ${assistantReply.profile_id} · ${assistantReply.locale}` : ""}
              {assistantReply?.feeling?.name ? ` · feeling ${assistantReply.feeling.name}` : ""}
            </p>
            <p className="operator-panel__result-detail">
              Voice dispatch: {textQuestionVoiceDispatch?.status ?? (assistantReply ? "awaiting handoff" : "idle")}
              {textQuestionVoiceDispatch?.profile_id ? ` · ${textQuestionVoiceDispatch.profile_id}` : ""}
            </p>
            <p className="operator-panel__result-detail">Lifecycle: {canonicalCatchUpLabel}</p>
          </div>
        </form>

        <form className="operator-panel__form" onSubmit={handleSubmitTtsPreview}>
          <label className="operator-panel__field" htmlFor="operator-tts-preview">
            <span className="operator-panel__field-label">TTS preview</span>
            <textarea
              id="operator-tts-preview"
              className="operator-panel__textarea"
              rows={4}
              value={ttsPreviewDraft}
              onChange={(event: { target: { value: string } }) => setTtsPreviewDraft(event.target.value)}
              placeholder="Preview text that should be published as canonical synthesis."
            />
          </label>
          <p className="operator-panel__hint">
            Posts only to {OPERATOR_COMMAND_ROUTE_PATH} as a tts_preview request, then waits for the canonical synthesis event and any real audio reference or timing metadata.
          </p>
          <div className="operator-panel__actions">
            <button className="operator-panel__button" type="submit" disabled={submitTtsPreviewDisabled}>
              Send TTS preview
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}