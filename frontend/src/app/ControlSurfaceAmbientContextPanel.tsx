import React, { useEffect, useState } from "react";
import {
  getAmbientContext,
  updateAmbientContext,
  type AmbientContextDocument
} from "../avatar/loaders/ambientContext";

// Curated common IANA zones for the dropdown. London is the default home zone.
// The stored value is always kept selectable even if it isn't in this list.
const COMMON_TIMEZONES: ReadonlyArray<string> = [
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Lisbon",
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland"
];

const DEFAULT_TIMEZONE = "Europe/London";

function buildFeedbackClassName(tone: "neutral" | "error" | "success"): string {
  if (tone === "error") {
    return "surface-panel__message surface-panel__message--error";
  }
  if (tone === "success") {
    return "surface-panel__message surface-panel__message--pending";
  }
  return "surface-panel__message";
}

export function ControlSurfaceAmbientContextPanel(): JSX.Element {
  const [draft, setDraft] = useState<AmbientContextDocument>({
    enabled: false,
    timezone: DEFAULT_TIMEZONE,
    location: "",
    weather_enabled: false,
    sky_enabled: false
  });
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"neutral" | "error" | "success">("neutral");

  // Hydrate from the backend on mount; never clobber an edit already in progress.
  useEffect(() => {
    let cancelled = false;
    void getAmbientContext().then((document) => {
      if (!cancelled && document && !isDirty) {
        setDraft({
          enabled: document.enabled,
          timezone: document.timezone || DEFAULT_TIMEZONE,
          location: document.location,
          weather_enabled: document.weather_enabled,
          sky_enabled: document.sky_enabled
        });
      }
    });
    return () => {
      cancelled = true;
    };
    // Intentionally run once on mount; later edits own the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the stored timezone selectable even if it isn't one of the presets.
  const timezoneOptions = COMMON_TIMEZONES.includes(draft.timezone)
    ? COMMON_TIMEZONES
    : [draft.timezone, ...COMMON_TIMEZONES];

  async function handleSave(): Promise<void> {
    setSaving(true);
    setMessage(null);
    const result = await updateAmbientContext({
      enabled: draft.enabled,
      timezone: draft.timezone,
      location: draft.location.trim(),
      weather_enabled: draft.weather_enabled,
      sky_enabled: draft.sky_enabled
    });
    setSaving(false);
    if (result) {
      setDraft({
        enabled: result.enabled,
        timezone: result.timezone || DEFAULT_TIMEZONE,
        location: result.location,
        weather_enabled: result.weather_enabled,
        sky_enabled: result.sky_enabled
      });
      setIsDirty(false);
      setMessage("Ambient context saved.");
      setMessageTone("success");
    } else {
      setMessage("Could not save ambient context.");
      setMessageTone("error");
    }
  }

  return (
    <section className="surface-panel" aria-labelledby="control-ambient-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Companion context</p>
          <h2 id="control-ambient-title">Time & place awareness</h2>
        </div>
      </div>
      <p className="surface-panel__summary">
        Gives the companion a small, always-on sense of the current local time, day, and place — injected into every
        reply so she can answer “what day is it?” or “is it the weekend?” without looking anything up. No network access.
      </p>

      {message ? <p className={buildFeedbackClassName(messageTone)}>{message}</p> : null}

      <label className="character-profile-panel__field">
        <span className="character-profile-panel__label">Enabled</span>
        <span className="character-profile-panel__hint">When off, no time/place context is added to the prompt.</span>
        <button
          type="button"
          className={
            draft.enabled
              ? "control-gesture-panel__button control-gesture-panel__button--active"
              : "control-gesture-panel__button"
          }
          aria-pressed={draft.enabled}
          disabled={saving}
          onClick={() => {
            setIsDirty(true);
            setDraft((current) => ({ ...current, enabled: !current.enabled }));
          }}
        >
          {draft.enabled ? "On" : "Off"}
        </button>
      </label>

      <label className="character-profile-panel__field">
        <span className="character-profile-panel__label">Timezone</span>
        <span className="character-profile-panel__hint">Local zone used for the time/day. Defaults to {DEFAULT_TIMEZONE}.</span>
        <select
          className="character-profile-panel__textarea"
          value={draft.timezone}
          disabled={saving}
          onChange={(event: { currentTarget: { value: string } }) => {
            const nextValue = event.currentTarget.value;
            setIsDirty(true);
            setDraft((current) => ({ ...current, timezone: nextValue }));
          }}
        >
          {timezoneOptions.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>

      <label className="character-profile-panel__field">
        <span className="character-profile-panel__label">Location</span>
        <span className="character-profile-panel__hint">
          Optional free-text place label (e.g. “Brighton, UK”). Leave blank to omit it.
        </span>
        <input
          type="text"
          className="character-profile-panel__textarea"
          value={draft.location}
          disabled={saving}
          placeholder="Brighton, UK"
          onChange={(event: { currentTarget: { value: string } }) => {
            const nextValue = event.currentTarget.value;
            setIsDirty(true);
            setDraft((current) => ({ ...current, location: nextValue }));
          }}
        />
      </label>

      <label className="character-profile-panel__field">
        <span className="character-profile-panel__label">Weather</span>
        <span className="character-profile-panel__hint">
          Adds a cached current-weather line for the location above (free, no API key). Refreshes in the background —
          never slows a reply. The only setting here that uses the internet.
        </span>
        <button
          type="button"
          className={
            draft.weather_enabled
              ? "control-gesture-panel__button control-gesture-panel__button--active"
              : "control-gesture-panel__button"
          }
          aria-pressed={draft.weather_enabled}
          disabled={saving}
          onClick={() => {
            setIsDirty(true);
            setDraft((current) => ({ ...current, weather_enabled: !current.weather_enabled }));
          }}
        >
          {draft.weather_enabled ? "On" : "Off"}
        </button>
      </label>

      <label className="character-profile-panel__field">
        <span className="character-profile-panel__label">Sky</span>
        <span className="character-profile-panel__hint">
          Adds part of day, season, and moon phase so she can greet the morning, notice you're up late, or mention a
          full moon. Pure local, no internet.
        </span>
        <button
          type="button"
          className={
            draft.sky_enabled
              ? "control-gesture-panel__button control-gesture-panel__button--active"
              : "control-gesture-panel__button"
          }
          aria-pressed={draft.sky_enabled}
          disabled={saving}
          onClick={() => {
            setIsDirty(true);
            setDraft((current) => ({ ...current, sky_enabled: !current.sky_enabled }));
          }}
        >
          {draft.sky_enabled ? "On" : "Off"}
        </button>
      </label>

      <button
        type="button"
        className="surface-panel__button character-profile-panel__save"
        disabled={saving}
        onClick={() => void handleSave()}
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </section>
  );
}
