/**
 * Process-wide audio-output mute for the avatar's reply playback.
 *
 * The speech playback bridge creates a fresh ``HTMLAudioElement`` per utterance,
 * so a UI mute toggle can't just flip one element. Instead the bridge registers
 * each playback element here; toggling the mute applies to every live element and
 * is remembered for elements created later. Used by the stage window's audio-out
 * mute button.
 */

let muted = false;
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

/** Register a playback element so it honours the current (and future) mute state.
 *  Returns an unregister function to call when the element is torn down. */
export function registerAudioOutputElement(element: HTMLAudioElement): () => void {
  liveElements.add(element);
  element.muted = muted;
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
