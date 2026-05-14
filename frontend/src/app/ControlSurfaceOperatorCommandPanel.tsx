import React, { useState } from "react";
import { OperatorCommandSubmitError, submitOperatorCommand } from "../avatar/loaders/operatorCommand";
import type {
  BackendAssistantMessageDocument,
  BackendOperatorCommandResponseDocument,
  BackendOperatorCommandType,
  CharacterCatalogEntry
} from "../shared/types/character";

type OperatorCommandSubmissionState = {
  status: "idle" | "submitting" | "ready" | "error";
  activeCommandType: BackendOperatorCommandType | null;
  response: BackendOperatorCommandResponseDocument | null;
  error: string | null;
};

interface ControlSurfaceOperatorCommandPanelProps {
  selectedCharacter: CharacterCatalogEntry | null;
  onCommandPublished: () => void;
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
    return `${getOperatorCommandLabel(state.activeCommandType)} is being posted to the backend operator-command route.`;
  }

  if (state.status === "error") {
    return state.error ?? "Backend operator-command request failed.";
  }

  if (state.response) {
    const assistantReply = getAssistantReply(state.response);

    if (state.response.command_type === "text_question" && assistantReply) {
      return `${getOperatorCommandLabel(state.response.command_type)} returned assistant status ${assistantReply.status}.`;
    }

    return `${getOperatorCommandLabel(state.response.command_type)} accepted on ${state.response.character_id} with ${state.response.speech_lifecycle_events.length} canonical speech event${state.response.speech_lifecycle_events.length === 1 ? "" : "s"} published.`;
  }

  return "Use these forms to publish backend-owned text-question and TTS-preview commands without creating a local display shortcut.";
}

function getAssistantReply(
  response: BackendOperatorCommandResponseDocument | null
): BackendAssistantMessageDocument | null {
  if (!response || response.command_type !== "text_question") {
    return null;
  }

  return response.session_event.assistant ?? response.speech_lifecycle_events[0]?.event.assistant ?? null;
}

export function ControlSurfaceOperatorCommandPanel({
  selectedCharacter,
  onCommandPublished
}: ControlSurfaceOperatorCommandPanelProps): JSX.Element {
  const [operatorCommandLocale, setOperatorCommandLocale] = useState("en-US");
  const [textQuestionDraft, setTextQuestionDraft] = useState("");
  const [ttsPreviewDraft, setTtsPreviewDraft] = useState("");
  const [operatorCommandState, setOperatorCommandState] = useState<OperatorCommandSubmissionState>({
    status: "idle",
    activeCommandType: null,
    response: null,
    error: null
  });

  function handleOperatorCommandSubmit(commandType: BackendOperatorCommandType, text: string): void {
    const locale = operatorCommandLocale.trim() || "en-US";

    setOperatorCommandState((currentState) => ({
      status: "submitting",
      activeCommandType: commandType,
      response: currentState.response,
      error: null
    }));

    void submitOperatorCommand({
      command_type: commandType,
      text,
      locale
    })
      .then((response) => {
        setOperatorCommandState({
          status: "ready",
          activeCommandType: commandType,
          response,
          error: null
        });
        onCommandPublished();
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

  const lastPublishedEvent = operatorCommandState.response?.speech_lifecycle_events[0]?.event.event_type ?? "No command submitted yet";
  const isSubmitting = operatorCommandState.status === "submitting";
  const assistantReply = getAssistantReply(operatorCommandState.response);

  return (
    <section className="surface-panel operator-panel" aria-labelledby="operator-command-panel-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Operator commands</p>
          <h2 id="operator-command-panel-title">Backend command seam</h2>
        </div>
      </div>

      <p className="surface-panel__message">{describeOperatorCommandState(operatorCommandState)}</p>

      <dl className="surface-panel__facts">
        <div>
          <dt>Target character</dt>
          <dd>{operatorCommandState.response?.character_id ?? selectedCharacter?.summary.characterId ?? "Awaiting backend confirmation"}</dd>
        </div>
        <div>
          <dt>Locale</dt>
          <dd>{operatorCommandLocale.trim() || "en-US"}</dd>
        </div>
        <div>
          <dt>Last published event</dt>
          <dd>{lastPublishedEvent}</dd>
        </div>
        <div>
          <dt>Next speech cursor</dt>
          <dd>{operatorCommandState.response?.next_speech_cursor ?? "Unchanged"}</dd>
        </div>
        {assistantReply ? (
          <div>
            <dt>Assistant status</dt>
            <dd>{assistantReply.status}</dd>
          </div>
        ) : null}
      </dl>

      {assistantReply ? <p className="surface-panel__message">{assistantReply.text}</p> : null}

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
          <p className="operator-panel__hint">Posts only to the backend operator-command route as a `text_question` request.</p>
          <div className="operator-panel__actions">
            <button className="operator-panel__button" type="submit" disabled={isSubmitting}>
              Send text question
            </button>
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
          <p className="operator-panel__hint">Posts only to the backend operator-command route as a `tts_preview` request.</p>
          <div className="operator-panel__actions">
            <button className="operator-panel__button" type="submit" disabled={isSubmitting}>
              Send TTS preview
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}