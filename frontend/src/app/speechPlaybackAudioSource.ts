export type SpeechAudioSourceResolutionReason = "missing" | "session_reference" | "machine_local" | "browser_safe";

export interface SpeechAudioSourceResolution {
  audioSource: string | null;
  reason: SpeechAudioSourceResolutionReason;
}

type ImportMetaWithOptionalEnv = ImportMeta & {
  env?: {
    VITE_BACKEND_API_BASE_URL?: string;
  };
};

function resolveFrontendBackendApiBaseUrl(): string {
  const configuredBaseUrl = (import.meta as ImportMetaWithOptionalEnv).env?.VITE_BACKEND_API_BASE_URL?.trim();

  if (!configuredBaseUrl) {
    return "/api";
  }

  return configuredBaseUrl.replace(/\/+$/, "");
}

function looksLikeWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

export function resolveSpeechSynthesisAudioSource(audioReference: string | null | undefined): SpeechAudioSourceResolution {
  const trimmedReference = audioReference?.trim();

  if (!trimmedReference || trimmedReference.startsWith("session://")) {
    return {
      audioSource: null,
      reason: trimmedReference ? "session_reference" : "missing"
    };
  }

  if (/^(https?:|blob:|data:)/i.test(trimmedReference)) {
    return {
      audioSource: trimmedReference,
      reason: "browser_safe"
    };
  }

  if (/^file:/i.test(trimmedReference) || looksLikeWindowsAbsolutePath(trimmedReference)) {
    return {
      audioSource: null,
      reason: "machine_local"
    };
  }

  if (trimmedReference.startsWith("/")) {
    return {
      audioSource: trimmedReference,
      reason: "browser_safe"
    };
  }

  const normalizedReference = trimmedReference.replace(/^\.?\//, "");

  if (normalizedReference.startsWith("api/")) {
    return {
      audioSource: `/${normalizedReference}`,
      reason: "browser_safe"
    };
  }

  return {
    audioSource: `${resolveFrontendBackendApiBaseUrl()}/${normalizedReference}`,
    reason: "browser_safe"
  };
}