import React, { useEffect, useState } from "react";
import {
  getImportantDates,
  updateImportantDates,
  type ImportantDateEntry
} from "../avatar/loaders/importantDates";

const MONTH_NAMES = [
  "",
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function formatEntryDate(entry: ImportantDateEntry): string {
  const month = MONTH_NAMES[entry.month] ?? "";
  return month ? `${entry.day} ${month}` : `${entry.month}/${entry.day}`;
}

function buildFeedbackClassName(tone: "neutral" | "error" | "success"): string {
  if (tone === "error") {
    return "surface-panel__message surface-panel__message--error";
  }
  if (tone === "success") {
    return "surface-panel__message surface-panel__message--pending";
  }
  return "surface-panel__message";
}

export function ControlSurfaceImportantDatesPanel(): JSX.Element {
  const [entries, setEntries] = useState<ImportantDateEntry[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [newDate, setNewDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"neutral" | "error" | "success">("neutral");

  useEffect(() => {
    let cancelled = false;
    void getImportantDates().then((loaded) => {
      if (!cancelled) {
        setEntries(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(next: ImportantDateEntry[], successMessage: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    const result = await updateImportantDates(next);
    setBusy(false);
    if (result) {
      setEntries(result);
      setMessage(successMessage);
      setMessageTone("success");
    } else {
      setMessage("Could not save important dates.");
      setMessageTone("error");
    }
  }

  async function handleAdd(): Promise<void> {
    const label = newLabel.trim();
    if (!label || !newDate) {
      setMessage("Add a label and a date first.");
      setMessageTone("error");
      return;
    }
    const [year, month, day] = newDate.split("-").map((part) => Number.parseInt(part, 10));
    if (!month || !day) {
      setMessage("That date didn't look right.");
      setMessageTone("error");
      return;
    }
    await persist([...entries, { label, month, day, year: Number.isFinite(year) ? year : null }], "Added.");
    setNewLabel("");
    setNewDate("");
  }

  async function handleRemove(index: number): Promise<void> {
    await persist(
      entries.filter((_, position) => position !== index),
      "Removed."
    );
  }

  return (
    <section className="surface-panel" aria-labelledby="control-important-dates-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Companion context</p>
          <h2 id="control-important-dates-title">Important dates</h2>
        </div>
      </div>
      <p className="surface-panel__summary">
        Birthdays, anniversaries, and other dates worth remembering. She'll mention them when they're today or within
        the next week. Recurring every year. Pure local, no internet.
      </p>

      {message ? <p className={buildFeedbackClassName(messageTone)}>{message}</p> : null}

      {entries.length === 0 ? (
        <p className="surface-panel__summary">No dates yet.</p>
      ) : (
        <ul className="important-dates-panel__list">
          {entries.map((entry, index) => (
            <li key={`${entry.label}-${entry.month}-${entry.day}-${index}`} className="important-dates-panel__row">
              <span className="important-dates-panel__label">{entry.label}</span>
              <span className="important-dates-panel__date">{formatEntryDate(entry)}</span>
              <button
                type="button"
                className="control-gesture-panel__button"
                disabled={busy}
                aria-label={`Remove ${entry.label}`}
                onClick={() => void handleRemove(index)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="important-dates-panel__add">
        <input
          type="text"
          className="character-profile-panel__textarea"
          placeholder="Label (e.g. Mum's birthday)"
          value={newLabel}
          disabled={busy}
          onChange={(event: { currentTarget: { value: string } }) => setNewLabel(event.currentTarget.value)}
        />
        <input
          type="date"
          className="character-profile-panel__textarea"
          value={newDate}
          disabled={busy}
          onChange={(event: { currentTarget: { value: string } }) => setNewDate(event.currentTarget.value)}
        />
        <button
          type="button"
          className="surface-panel__button"
          disabled={busy}
          onClick={() => void handleAdd()}
        >
          {busy ? "Saving…" : "Add date"}
        </button>
      </div>
    </section>
  );
}
