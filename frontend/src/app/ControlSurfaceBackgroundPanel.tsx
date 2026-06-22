import React, { useEffect, useState } from "react";
import { STAGE_BACKGROUND_PRESETS } from "../avatar/runtime/backgroundController";
import { getStageBackground, setStageBackground, StageBackgroundError } from "../avatar/loaders/stageBackground";

export function ControlSurfaceBackgroundPanel(): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  // Reflect the backend-held current backdrop so the active option is highlighted.
  useEffect(() => {
    let cancelled = false;
    void getStageBackground().then((id) => {
      if (!cancelled && id) {
        setSelectedId(id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSelectBackground(backgroundId: string): Promise<void> {
    setPendingId(backgroundId);
    setStatusMessage(null);
    setIsError(false);
    try {
      await setStageBackground(backgroundId);
      setSelectedId(backgroundId);
    } catch (error) {
      const detail =
        error instanceof StageBackgroundError ? error.detail ?? error.message : "Background request failed.";
      setStatusMessage(detail);
      setIsError(true);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="surface-panel control-gesture-panel" aria-labelledby="control-background-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Stage</p>
          <h2 id="control-background-title">Background</h2>
        </div>
      </div>
      <p className="surface-panel__summary">
        Backdrop for the avatar stage / display window. Transparent renders the character with no background (for a floating desktop overlay). More scenes can be added later.
      </p>
      <div className="control-gesture-panel__grid">
        {STAGE_BACKGROUND_PRESETS.map((preset) => {
          const isActive = selectedId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              className={
                isActive
                  ? "control-gesture-panel__button control-gesture-panel__button--active"
                  : "control-gesture-panel__button"
              }
              aria-pressed={isActive}
              disabled={pendingId !== null}
              aria-busy={pendingId === preset.id}
              onClick={() => void handleSelectBackground(preset.id)}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      {statusMessage ? (
        <p
          className={isError ? "surface-panel__message surface-panel__message--error" : "surface-panel__message"}
          role="status"
        >
          {statusMessage}
        </p>
      ) : null}
    </section>
  );
}
