/**
 * Process-wide audio-output control for the avatar's reply playback.
 *
 * The speech playback bridge creates a fresh ``HTMLAudioElement`` per utterance,
 * so UI controls can't just flip one element. Instead the bridge registers each
 * playback element here; the current mute state AND the selected output device
 * (sink) are applied to every live element and remembered for elements created
 * later. Used by the stage window's audio-out mute button and the control
 * surface's output-device picker.
 *
 * The selected output device id is persisted in the backend (so any surface gets
 * it on load); this module just applies whatever id it is told via setSinkId.
 */

let muted = false;
// null = system default output device. A non-null id is a deviceId from
// navigator.mediaDevices.enumerateDevices() (kind === "audiooutput").
let sinkId: string | null = null;
const liveElements = new Set<HTMLAudioElement>();
const listeners = new Set<(muted: boolean) => void>();

export function isAudioOutputMuted(): boolean {
  return muted;
}

export function setAudioOutputMuted(next: boolean): void {
  muted = next;
  for (const element of liveElements) {
    element.muted = muted;
  }
  for (const listener of listeners) {
    listener(muted);
  }
}

export function getAudioOutputSinkId(): string | null {
  return sinkId;
}

type SinkCapableAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

/** Whether the current browser supports routing audio to a chosen output device. */
export function isAudioOutputSinkSelectionSupported(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

function applySinkToElement(element: HTMLAudioElement): void {
  const sinkCapable = element as SinkCapableAudioElement;
  if (typeof sinkCapable.setSinkId !== "function") {
    return;
  }
  // Empty string routes back to the system default device.
  void sinkCapable.setSinkId(sinkId ?? "").catch(() => {
    // A device can vanish (unplugged) or be disallowed; fall back silently to the
    // default rather than breaking playback.
  });
}

/** Route all current and future playback elements to the given output device.
 *  Pass null to use the system default. Returns a promise that settles once the
 *  live elements have been (best-effort) re-routed. */
export async function setAudioOutputSinkId(nextSinkId: string | null): Promise<void> {
  sinkId = nextSinkId || null;
  await Promise.all(
    Array.from(liveElements, (element) => {
      const sinkCapable = element as SinkCapableAudioElement;
      if (typeof sinkCapable.setSinkId !== "function") {
        return Promise.resolve();
      }
      return sinkCapable.setSinkId(sinkId ?? "").catch(() => undefined);
    })
  );
}

/** Register a playback element so it honours the current (and future) mute state
 *  and selected output device. Returns an unregister function to call when the
 *  element is torn down. */
export function registerAudioOutputElement(element: HTMLAudioElement): () => void {
  liveElements.add(element);
  element.muted = muted;
  applySinkToElement(element);
  return () => {
    liveElements.delete(element);
  };
}

export function subscribeAudioOutputMuted(listener: (muted: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
