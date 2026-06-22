import React, { useState } from "react";
import {
  OPERATOR_COMMAND_ROUTE_PATH,
  OperatorCommandSubmitError,
  submitOperatorCommand
} from "../avatar/loaders/operatorCommand.js";
import type {
  BackendAssistantMessageDocument,
  BackendOperatorCommandResponseDocument,
  BackendOperatorCommandType,
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

/**
 * Which operator-command form this instance renders. The control surface mounts
 * one instance per tab: the "llm" variant drives text questions (conversation),
 * the "tts" variant drives the TTS preview and shows synthesis/playback
 * diagnostics. Each instance owns its own submission state; canonical results
 * arrive via the shared speech.lifecycle snapshot.
 */
export type OperatorCommandPanelVariant = "llm" | "tts";

type OperatorCommandSubmissionState = {
  status: "idle" | "submitting" | "ready" | "error";
  activeCommandType: BackendOperatorCommandType | null;
  submittedText: string | null;
  response: BackendOperatorCommandResponseDocument | null;
  error: string | null;
};

interface ControlSurfaceOperatorCommandPanelProps {
  variant: OperatorCommandPanelVariant;
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

export function describeBackendCanonicalBundleReadiness(playback: SpeechPlaybackState): string | null {
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

export function renderSpeechBundleTimeline(playback: SpeechPlaybackState): JSX.Element | null {
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
  variant,
  selectedCharacter,
  speechLifecycleState,
  speechPlaybackStatus,
  onCommandPublished
}: ControlSurfaceOperatorCommandPanelProps): JSX.Element {
  const isLlmVariant = variant === "llm";
  const [operatorCommandLocale, setOperatorCommandLocale] = useState("en-US");
  const [textQuestionDraft, setTextQuestionDraft] = useState("");
  const [ttsPreviewDraft, setTtsPreviewDraft] = useState("");
  const [operatorCommandState, setOperatorCommandState] = useState<OperatorCommandSubmissionState>({
    status: "idle",
    activeCommandType: null,
    submittedText: null,
    response: null,
    error: null
  });

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
  const isBlockingTextQuestionResult =
    operatorCommandState.activeCommandType === "text_question" &&
    (operatorCommandState.status === "submitting" || operatorCommandState.status === "error");
  const assistantReply = isBlockingTextQuestionResult
    ? null
    : resolvePreferredAssistantReply(operatorCommandState.response, speechLifecycleSnapshot);
  const textQuestionVoiceDispatch = isBlockingTextQuestionResult ? null : getTextQuestionVoiceDispatch(operatorCommandState.response);
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

  return (
    <section className="surface-panel operator-panel" aria-labelledby="operator-command-panel-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">{isLlmVariant ? "Conversation" : "Voice synthesis"}</p>
          <h2 id="operator-command-panel-title">{isLlmVariant ? "Text question relay" : "TTS preview"}</h2>
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

      <label className="operator-panel__field operator-panel__field--inline" htmlFor="operator-command-locale">
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
        {isLlmVariant ? (
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
        ) : null}

        {!isLlmVariant ? (
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
        ) : null}
      </div>
    </section>
  );
}