import React from "react";
import { useAutoRevealOnPointer } from "./useAutoRevealOnPointer";

function PinIcon({ active }: { active: boolean }): JSX.Element {
  // A pushpin: outline when off, filled when pinned (always-on-top).
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z" />
      <line x1="12" y1="14" x2="12" y2="21" />
    </svg>
  );
}

interface StageAlwaysOnTopToggleProps {
  alwaysOnTop: boolean;
  onToggle: () => void;
}

/**
 * Top-right "always on top" toggle for the standalone stage (Tauri) window. When
 * on, the window is pinned above everything and rendered frameless (no title bar
 * / min / max / close). Auto-reveals on mouse movement so the avatar stays clean,
 * but it is the escape hatch out of frameless mode, so it also stays visible
 * while pinned. The setting is persisted backend-side (see useDisplaySettings).
 */
export function StageAlwaysOnTopToggle({ alwaysOnTop, onToggle }: StageAlwaysOnTopToggleProps): JSX.Element {
  // Auto-hide on idle and reveal on mouse movement, exactly like the bottom
  // stage controls. (Moving the mouse always brings it back, so it stays the
  // escape hatch out of frameless mode without cluttering the avatar.)
  const visible = useAutoRevealOnPointer();

  return (
    <div className="stage-topright" data-visible={visible ? "true" : "false"}>
      <button
        type="button"
        className={alwaysOnTop ? "stage-controls__icon stage-controls__icon--on" : "stage-controls__icon"}
        aria-pressed={alwaysOnTop}
        aria-label={alwaysOnTop ? "Disable always on top" : "Enable always on top (frameless)"}
        title={alwaysOnTop ? "Always on top — frameless. Click to restore the window frame." : "Always on top (frameless)"}
        data-testid="stage-always-on-top"
        onClick={onToggle}
      >
        <PinIcon active={alwaysOnTop} />
      </button>
    </div>
  );
}
