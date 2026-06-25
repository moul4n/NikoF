import React, { useEffect, useState } from "react";
import { useCharacterProfile } from "./useCharacterProfile";

function buildFeedbackClassName(tone: "neutral" | "error" | "success"): string {
  if (tone === "error") {
    return "surface-panel__message surface-panel__message--error";
  }
  if (tone === "success") {
    return "surface-panel__message surface-panel__message--pending";
  }
  return "surface-panel__message";
}

const PROFILE_FIELDS: ReadonlyArray<{
  key: "personality" | "directives_do" | "directives_dont" | "response_formatting";
  label: string;
  hint: string;
  rows: number;
}> = [
  {
    key: "personality",
    label: "Personality & background",
    hint: "Who she is — tone, character, backstory.",
    rows: 5
  },
  {
    key: "directives_do",
    label: "Do",
    hint: "Things she should always do.",
    rows: 4
  },
  {
    key: "directives_dont",
    label: "Don't",
    hint: "Things to avoid (e.g. no emojis — they break the TTS voice).",
    rows: 4
  },
  {
    key: "response_formatting",
    label: "Response formatting / TTS rules",
    hint: "How to word replies so they sound right aloud (e.g. say 123,456 as words grouped in thousands).",
    rows: 5
  }
];

export function ControlSurfaceCharacterProfilePanel(): JSX.Element {
  const { state, saveProfile } = useCharacterProfile();
  const [draft, setDraft] = useState({
    personality: "",
    directives_do: "",
    directives_dont: "",
    response_formatting: ""
  });
  // Once the operator starts editing, the draft is authoritative. The profile
  // GET resolves a few seconds after mount (the backend is warming models on
  // startup), so without this guard that late response would overwrite text the
  // operator is mid-way through typing — looking like the page "refreshed".
  const [isDirty, setIsDirty] = useState(false);

  // Hydrate the editor from the backend when it loads, but never clobber edits
  // already in progress. Reset to clean after a save so a future external
  // refresh can hydrate again.
  useEffect(() => {
    if (state.snapshot && !isDirty) {
      setDraft({
        personality: state.snapshot.personality,
        directives_do: state.snapshot.directives_do,
        directives_dont: state.snapshot.directives_dont,
        response_formatting: state.snapshot.response_formatting
      });
    }
  }, [state.snapshot, isDirty]);

  const saving = state.action === "saving";

  return (
    <section className="surface-panel character-profile-panel" aria-labelledby="character-profile-panel-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Settings tab</p>
          <h2 id="character-profile-panel-title">Character profile</h2>
        </div>
      </div>

      <p className="surface-panel__summary">
        A shared context profile injected into the model on every turn. Applies to whichever character is active and persists in the companion memory database.
      </p>

      {state.status === "loading" ? <p className="surface-panel__message">Loading character profile.</p> : null}
      {state.message ? <p className={buildFeedbackClassName(state.messageTone)}>{state.message}</p> : null}

      {PROFILE_FIELDS.map((field) => (
        <label key={field.key} className="character-profile-panel__field">
          <span className="character-profile-panel__label">{field.label}</span>
          <span className="character-profile-panel__hint">{field.hint}</span>
          <textarea
            className="character-profile-panel__textarea"
            value={draft[field.key]}
            rows={field.rows}
            disabled={saving}
            onChange={(event: { currentTarget: { value: string } }) => {
              // Capture the value synchronously: React nulls `event.currentTarget`
              // after the handler returns, but the functional setState updater runs
              // later (during re-render), so reading it inside the updater throws and
              // blanks the page. https://react.dev/reference/react-dom/components/common
              const nextValue = event.currentTarget.value;
              setIsDirty(true);
              setDraft((current) => ({ ...current, [field.key]: nextValue }));
            }}
          />
        </label>
      ))}

      <button
        type="button"
        className="surface-panel__button character-profile-panel__save"
        disabled={saving}
        onClick={() => {
          void saveProfile(draft).then(() => setIsDirty(false));
        }}
      >
        {saving ? "Saving…" : "Save profile"}
      </button>
    </section>
  );
}
