/**
 * Thin, defensive bridge to the Tauri window for the standalone stage shell.
 *
 * The stage frontend is the SAME bundle whether it runs inside the Tauri
 * desktop window or in a plain browser tab, so every call here is guarded:
 * outside Tauri it is a no-op. Uses the global `window.__TAURI__` API
 * (`withGlobalTauri` in tauri.conf.json) so the web build needs no
 * `@tauri-apps/api` dependency. The window must also grant
 * `core:window:allow-set-always-on-top` / `allow-set-decorations` (see
 * src-tauri/capabilities/default.json).
 */

interface TauriWindowLike {
  setAlwaysOnTop?: (value: boolean) => Promise<void>;
  setDecorations?: (value: boolean) => Promise<void>;
}

interface TauriGlobal {
  window?: {
    getCurrentWindow?: () => TauriWindowLike;
  };
}

function getTauri(): TauriGlobal | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

/** True only when running inside the Tauri desktop shell (not a browser tab). */
export function isTauriStageWindow(): boolean {
  return typeof getTauri()?.window?.getCurrentWindow === "function";
}

/**
 * Apply the "always on top" window mode: pin above other windows AND drop the
 * native frame (title bar / min / max / close) so the avatar floats as a
 * frameless overlay. Turning it off restores normal stacking and the frame.
 * No-op outside Tauri or if the capability is not granted.
 */
export async function applyStageAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
  const current = getTauri()?.window?.getCurrentWindow?.();
  if (!current) {
    return;
  }
  try {
    await current.setAlwaysOnTop?.(alwaysOnTop);
    // Frameless when pinned; restore the OS frame when unpinned.
    await current.setDecorations?.(!alwaysOnTop);
  } catch {
    // Best effort: a missing capability, an unsupported platform, or a window
    // that has gone away should never break the avatar render.
  }
}
