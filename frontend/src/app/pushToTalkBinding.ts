/**
 * Shared push-to-talk key binding (used by both the control settings panel and
 * the display surface's hold-to-talk button) so the configured key is the same
 * everywhere. Persisted in localStorage under a single key.
 */

export type PushToTalkBinding = {
  code: string | null;
  key: string | null;
};

export const PUSH_TO_TALK_STORAGE_KEY = "nikof.stt.pushToTalkKey";
export const DEFAULT_PUSH_TO_TALK_BINDING: PushToTalkBinding = {
  code: "KeyQ",
  key: "q"
};

export function normalizePushToTalkBinding(value: unknown): PushToTalkBinding {
  if (!value || typeof value !== "object") {
    return DEFAULT_PUSH_TO_TALK_BINDING;
  }

  const candidate = value as { code?: unknown; key?: unknown };
  const code = typeof candidate.code === "string" && candidate.code.trim().length > 0 ? candidate.code.trim() : null;
  const key = typeof candidate.key === "string" && candidate.key.length > 0 ? candidate.key : null;
  if (!code && !key) {
    return DEFAULT_PUSH_TO_TALK_BINDING;
  }

  return { code, key };
}

export function readPersistedPushToTalkBinding(): PushToTalkBinding {
  if (typeof window === "undefined") {
    return DEFAULT_PUSH_TO_TALK_BINDING;
  }

  const persistedValue = window.localStorage.getItem(PUSH_TO_TALK_STORAGE_KEY);
  if (!persistedValue) {
    return DEFAULT_PUSH_TO_TALK_BINDING;
  }

  try {
    return normalizePushToTalkBinding(JSON.parse(persistedValue));
  } catch {
    return DEFAULT_PUSH_TO_TALK_BINDING;
  }
}

export function writePersistedPushToTalkBinding(binding: PushToTalkBinding): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PUSH_TO_TALK_STORAGE_KEY, JSON.stringify(binding));
}

export function isModifierOnlyKey(key: string): boolean {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta";
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;
  return target.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

export function matchesPushToTalkBinding(event: KeyboardEvent, binding: PushToTalkBinding): boolean {
  if (binding.code && event.code === binding.code) {
    return true;
  }

  if (!binding.key) {
    return false;
  }

  return event.key.toLowerCase() === binding.key.toLowerCase();
}

export function formatPushToTalkBindingLabel(binding: PushToTalkBinding): string {
  if (binding.code?.startsWith("Key") && binding.code.length === 4) {
    return binding.code.slice(3);
  }

  if (binding.code?.startsWith("Digit") && binding.code.length === 6) {
    return binding.code.slice(5);
  }

  switch (binding.code) {
    case "Space":
      return "Space";
    case "Escape":
      return "Esc";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    default:
      break;
  }

  if (binding.key === " ") {
    return "Space";
  }

  if (binding.key && binding.key.length === 1) {
    return binding.key.toUpperCase();
  }

  if (binding.key) {
    return `${binding.key.charAt(0).toUpperCase()}${binding.key.slice(1)}`;
  }

  return "Unassigned";
}
