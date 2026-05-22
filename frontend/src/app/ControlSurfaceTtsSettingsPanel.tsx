import React, { useEffect, useState } from "react";
import { useTtsReferenceSettings } from "./useTtsReferenceSettings";

function buildFeedbackClassName(
  baseClassName: "surface-panel__message" | "surface-panel__summary",
  tone: "neutral" | "error" | "success"
): string {
  if (tone === "error") {
    return `${baseClassName} ${baseClassName}--error`;
  }

  if (tone === "success") {
    return `${baseClassName} ${baseClassName}--pending`;
  }

  return baseClassName;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export function ControlSurfaceTtsSettingsPanel(): JSX.Element {
  const { state, saveSettings } = useTtsReferenceSettings();
  const [promptText, setPromptText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  useEffect(() => {
    setPromptText(state.snapshot?.prompt_text ?? "");
  }, [state.snapshot?.prompt_text]);

  const maxReferenceAudioBytes = state.snapshot?.max_reference_audio_bytes ?? 5 * 1024 * 1024;
  const selectedFileLabel = selectedFile?.name ?? state.snapshot?.reference_audio_file_name ?? "No reference WAV saved";
  const messageClassName = buildFeedbackClassName("surface-panel__message", state.messageTone);
  const summaryClassName = buildFeedbackClassName("surface-panel__summary", state.messageTone);

  async function handleSave(): Promise<void> {
    await saveSettings(promptText, selectedFile);
    if (selectedFile !== null) {
      setSelectedFile(null);
      setFileInputKey((currentKey) => currentKey + 1);
    }
  }

  return (
    <section className="surface-panel tts-settings-panel" aria-labelledby="tts-settings-panel-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Settings tab</p>
          <h2 id="tts-settings-panel-title">TTS reference settings</h2>
        </div>
      </div>

      <p className="surface-panel__summary">
        Save the reference WAV and prompt text that GPT-SoVITS needs for synthesis. The file is stored under the managed local TTS model root, not in the repo.
      </p>

      {state.status === "loading" ? <p className="surface-panel__message">Loading TTS reference settings.</p> : null}
      {state.message ? <p className={state.messageTone === "neutral" ? "surface-panel__message" : messageClassName}>{state.message}</p> : null}

      <dl className="surface-panel__facts">
        <div>
          <dt>Status</dt>
          <dd>{state.snapshot?.configured ? "Configured" : "Reference still incomplete"}</dd>
        </div>
        <div>
          <dt>Current WAV</dt>
          <dd>{selectedFileLabel}</dd>
        </div>
        <div>
          <dt>Allowed type</dt>
          <dd>.wav</dd>
        </div>
        <div>
          <dt>File limit</dt>
          <dd>{formatMegabytes(maxReferenceAudioBytes)}</dd>
        </div>
      </dl>

      <div className="tts-settings-panel__form">
        <label className="tts-settings-panel__field">
          <span className="tts-settings-panel__label">Reference WAV</span>
          <input
            key={fileInputKey}
            className="tts-settings-panel__input"
            type="file"
            accept=".wav,audio/wav"
            onChange={(event: any) => {
              const nextFile = event.target.files?.[0] ?? null;
              setSelectedFile(nextFile);
            }}
          />
          <span className="tts-settings-panel__hint">WAV only. Maximum size: {formatMegabytes(maxReferenceAudioBytes)}.</span>
        </label>

        <label className="tts-settings-panel__field">
          <span className="tts-settings-panel__label">Reference prompt text</span>
          <textarea
            className="tts-settings-panel__textarea"
            rows={5}
            value={promptText}
            onChange={(event: any) => setPromptText(event.target.value)}
            placeholder="Describe the delivery captured by the reference clip."
          />
          <span className="tts-settings-panel__hint">This text is saved alongside the WAV and reused by the local GPT-SoVITS sidecar.</span>
        </label>

        <div className="tts-settings-panel__actions">
          <button type="button" className="tts-settings-panel__button" disabled={state.action === "saving" || state.status === "loading"} onClick={() => void handleSave()}>
            {state.action === "saving" ? "Saving..." : "Save TTS reference"}
          </button>
        </div>
      </div>

      {state.snapshot?.reference_audio_path ? <p className={summaryClassName}>Stored at {state.snapshot.reference_audio_path}</p> : null}
    </section>
  );
}