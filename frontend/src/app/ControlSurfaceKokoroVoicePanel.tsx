import React from "react";
import { useKokoroVoices, type KokoroVoiceOption } from "./useKokoroVoices.js";

function groupVoicesByLanguage(voices: KokoroVoiceOption[]): { language: string; english: boolean; voices: KokoroVoiceOption[] }[] {
  const groups = new Map<string, { language: string; english: boolean; voices: KokoroVoiceOption[] }>();
  for (const voice of voices) {
    const group = groups.get(voice.language) ?? { language: voice.language, english: voice.english, voices: [] };
    group.voices.push(voice);
    groups.set(voice.language, group);
  }
  // English groups first (the backend already sorts voices that way), preserving
  // the backend ordering otherwise.
  return [...groups.values()].sort((left, right) => Number(right.english) - Number(left.english));
}

/**
 * Kokoro voice picker for the TTS tab. Lists every installed female voice and,
 * on selection, updates the running model immediately (the backend swaps the
 * voice embedding in place and persists the choice across restarts). Output
 * language is unchanged — only the voice timbre/pitch changes.
 */
export function ControlSurfaceKokoroVoicePanel(): JSX.Element {
  const { state, setVoice } = useKokoroVoices();
  const snapshot = state.snapshot;
  const voiceGroups = snapshot ? groupVoicesByLanguage(snapshot.voices) : [];
  const messageClassName =
    state.messageTone === "error"
      ? "surface-panel__summary surface-panel__summary--error"
      : state.messageTone === "success"
        ? "surface-panel__summary surface-panel__summary--success"
        : "surface-panel__summary";

  return (
    <section className="surface-panel" aria-labelledby="kokoro-voice-panel-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Kokoro voice</p>
          <h2 id="kokoro-voice-panel-title">Female voice picker</h2>
        </div>
      </div>

      <p className="surface-panel__summary">
        Pick the Kokoro voice timbre. The change applies to the next reply with no restart and persists across restarts.
        Output language is unaffected — only the voice changes.
      </p>

      {state.status === "loading" ? <p className="surface-panel__summary">Loading installed voices…</p> : null}
      {state.status === "offline" ? <p className="surface-panel__summary surface-panel__summary--error">{state.message}</p> : null}

      {snapshot && !snapshot.available ? (
        <p className="surface-panel__summary surface-panel__summary--error">
          No Kokoro voices file is installed, so the voice list is empty.
        </p>
      ) : null}

      {snapshot && snapshot.available ? (
        <>
          <label className="operator-panel__field" htmlFor="kokoro-voice-select">
            <span className="operator-panel__field-label">Voice ({snapshot.voices.length} female · English output)</span>
            <select
              id="kokoro-voice-select"
              className="operator-panel__input"
              value={snapshot.selected_voice}
              disabled={state.action === "saving"}
              onChange={(event: { target: { value: string } }) => void setVoice(event.target.value)}
            >
              {voiceGroups.map((group) => (
                <optgroup key={group.language} label={group.language}>
                  {group.voices.map((voice) => (
                    <option key={voice.voice_id} value={voice.voice_id}>
                      {voice.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          {!snapshot.engine_active ? (
            <p className="surface-panel__summary">
              Note: the active TTS engine is not Kokoro right now, so this voice applies only when Kokoro is the synthesis engine
              (NIKOF_TTS_ENGINE=kokoro).
            </p>
          ) : null}
        </>
      ) : null}

      {state.message ? <p className={messageClassName}>{state.message}</p> : null}
    </section>
  );
}
