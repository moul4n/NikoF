import { useEffect, useState } from "react";
import type {
  AvatarRuntimeBridge,
  AvatarSpeechReactionInput
} from "../avatar/runtime/avatarRuntime";
import type {
  BackendSessionEventDocument,
  BackendSpeechSynthesisDocument
} from "../shared/types/character";
import {
  resolveSpeechSynthesisAudioSource,
  type SpeechAudioSourceResolutionReason
} from "./speechPlaybackAudioSource";

export type SpeechPlaybackStatus = "idle" | "audio" | "timing";
export type SpeechPlaybackTransport = "none" | "audio_reference" | "timing_window";

export interface SpeechPlaybackState {
  status: SpeechPlaybackStatus;
  transport: SpeechPlaybackTransport;
  playbackKey: string | null;
  message: string;
  error: string | null;
  audioReference: string | null;
  audioSource: string | null;
  synthesisStatus: string | null;
  profileId: string | null;
  locale: string | null;
  utteranceDurationMs: number | null;
  text: string | null;
}

interface UseSpeechPlaybackBridgeOptions {
  runtime: AvatarRuntimeBridge;
  canonicalSynthesisEvent: BackendSessionEventDocument | null;
}

interface SpeechPlaybackStateSeed {
  playbackKey: string;
  audioReference: string | null;
  synthesisStatus: string | null;
  profileId: string | null;
  locale: string | null;
  utteranceDurationMs: number | null;
  text: string | null;
}

const AUDIO_PLAYBACK_STARTUP_TIMEOUT_MS = 8000;

export function useSpeechPlaybackBridge({
  runtime,
  canonicalSynthesisEvent
}: UseSpeechPlaybackBridgeOptions): SpeechPlaybackState {
  const [speechPlaybackStatus, setSpeechPlaybackStatus] = useState<SpeechPlaybackState>(() => createIdleSpeechPlaybackState());
  const [speechPlaybackBridge] = useState(() => ({
    activeAudio: null as HTMLAudioElement | null,
    cleanupActiveAudio: null as (() => void) | null,
    playbackTimeoutId: null as number | null,
    handledPlaybackKey: null as string | null,
    pendingPlaybackStateSeed: null as SpeechPlaybackStateSeed | null,
    pendingTimingMessage: null as string | null
  }));

  useEffect(() => {
    return () => {
      stopSpeechPlayback(true);
    };
  }, []);

  useEffect(() => {
    const playbackKey = buildSpeechSynthesisPlaybackKey(canonicalSynthesisEvent);

    if (!playbackKey || !canonicalSynthesisEvent?.synthesis) {
      stopSpeechPlayback(true);
      return;
    }

    if (speechPlaybackBridge.handledPlaybackKey === playbackKey) {
      return;
    }

    stopSpeechPlayback(false);
    speechPlaybackBridge.handledPlaybackKey = playbackKey;

    const playbackStateSeed = buildSpeechPlaybackStateSeed(canonicalSynthesisEvent, playbackKey);
    const audioResolution = resolveSpeechSynthesisAudioSource(canonicalSynthesisEvent.synthesis.audio_reference);
    const speechReactionInput = resolveSpeechReactionInput(canonicalSynthesisEvent.synthesis);
    const durationMs = speechReactionInput.utteranceDurationMs;

    if (audioResolution.audioSource) {
      speechPlaybackBridge.pendingPlaybackStateSeed = playbackStateSeed;
      speechPlaybackBridge.pendingTimingMessage = null;
      const audioSource = audioResolution.audioSource;
      beginAudioSpeechPlayback(audioSource, durationMs, playbackKey, speechReactionInput);
      return;
    }

    if (typeof durationMs === "number" && durationMs > 0) {
      speechPlaybackBridge.pendingPlaybackStateSeed = playbackStateSeed;
      speechPlaybackBridge.pendingTimingMessage = buildTimingPlaybackMessage(audioResolution.reason);
      beginTimingSpeechWindow(durationMs, playbackKey, speechReactionInput);
      return;
    }

    speechPlaybackBridge.pendingPlaybackStateSeed = null;
    speechPlaybackBridge.pendingTimingMessage = null;
    runtime.clearSpeechReaction();
    setSpeechPlaybackStatus(
      buildSpeechPlaybackState(playbackStateSeed, {
        status: "idle",
        transport: "none",
        message: buildUnavailablePlaybackMessage(audioResolution.reason)
      })
    );
  }, [canonicalSynthesisEvent, runtime, speechPlaybackBridge]);

  return speechPlaybackStatus;

  function clearSpeechPlaybackTimeout(): void {
    if (speechPlaybackBridge.playbackTimeoutId !== null) {
      window.clearTimeout(speechPlaybackBridge.playbackTimeoutId);
      speechPlaybackBridge.playbackTimeoutId = null;
    }
  }

  function releaseSpeechAudio(): void {
    const activeAudio = speechPlaybackBridge.activeAudio;

    if (!activeAudio) {
      return;
    }

    speechPlaybackBridge.cleanupActiveAudio?.();
    speechPlaybackBridge.cleanupActiveAudio = null;
    activeAudio.pause();
    activeAudio.src = "";
    speechPlaybackBridge.activeAudio = null;
  }

  function stopSpeechPlayback(resetHandledKey: boolean): void {
    clearSpeechPlaybackTimeout();
    releaseSpeechAudio();
    runtime.clearSpeechReaction();

    if (resetHandledKey) {
      speechPlaybackBridge.handledPlaybackKey = null;
      speechPlaybackBridge.pendingPlaybackStateSeed = null;
      speechPlaybackBridge.pendingTimingMessage = null;
      setSpeechPlaybackStatus(createIdleSpeechPlaybackState());
    }
  }

  function beginTimingSpeechWindow(
    durationMs: number,
    playbackKey: string,
    speechReactionInput: AvatarSpeechReactionInput,
    error: string | null = null
  ): void {
    const playbackStateSeed = speechPlaybackBridge.pendingPlaybackStateSeed;

    if (!playbackStateSeed) {
      stopSpeechPlayback(true);
      return;
    }

    const message = speechPlaybackBridge.pendingTimingMessage ?? "No browser-playable audio reference was published, so the bridge is using canonical timing metadata.";

    clearSpeechPlaybackTimeout();
    releaseSpeechAudio();
    runtime.beginSpeechReaction(speechReactionInput);
    setSpeechPlaybackStatus(
      buildSpeechPlaybackState(playbackStateSeed, {
        status: "timing",
        transport: "timing_window",
        message,
        error
      })
    );
    speechPlaybackBridge.playbackTimeoutId = window.setTimeout(() => {
      if (speechPlaybackBridge.handledPlaybackKey !== playbackKey) {
        return;
      }

      runtime.clearSpeechReaction();
      setSpeechPlaybackStatus(
        buildSpeechPlaybackState(playbackStateSeed, {
          status: "idle",
          transport: "timing_window",
          message: "Canonical timing window completed.",
          error
        })
      );
      speechPlaybackBridge.playbackTimeoutId = null;
    }, durationMs);
  }

  function beginAudioSpeechPlayback(
    audioSource: string,
    durationMs: number | null,
    playbackKey: string,
    speechReactionInput: AvatarSpeechReactionInput
  ): void {
    const playbackStateSeed = speechPlaybackBridge.pendingPlaybackStateSeed;

    if (!playbackStateSeed) {
      stopSpeechPlayback(true);
      return;
    }

    clearSpeechPlaybackTimeout();
    releaseSpeechAudio();

    const playbackAudio = new Audio(audioSource);
    playbackAudio.volume = 1.0;
    playbackAudio.muted = false;
    let settled = false;

    speechPlaybackBridge.activeAudio = playbackAudio;
    setSpeechPlaybackStatus(
      buildSpeechPlaybackState(playbackStateSeed, {
        status: "audio",
        transport: "audio_reference",
        audioSource,
        message: "Loading canonical audio reference."
      })
    );

    const cleanupPlaybackAudio = (): void => {
      playbackAudio.removeEventListener("playing", handlePlaying);
      playbackAudio.removeEventListener("ended", handleEnded);
      playbackAudio.removeEventListener("error", handleError);
      speechPlaybackBridge.cleanupActiveAudio = null;

      if (speechPlaybackBridge.activeAudio === playbackAudio) {
        speechPlaybackBridge.activeAudio = null;
      }
    };

    speechPlaybackBridge.cleanupActiveAudio = cleanupPlaybackAudio;
    speechPlaybackBridge.playbackTimeoutId = window.setTimeout(() => {
      console.warn("[SpeechPlayback] Startup timeout fired — audio did not start in time", { playbackKey });
      fallbackToTiming("Canonical audio reference did not begin playback before the bridge timeout.");
    }, resolveAudioPlaybackStartupTimeoutMs());

    const finishPlayback = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupPlaybackAudio();
      clearSpeechPlaybackTimeout();

      if (speechPlaybackBridge.handledPlaybackKey !== playbackKey) {
        return;
      }

      runtime.clearSpeechReaction();
      setSpeechPlaybackStatus(
        buildSpeechPlaybackState(playbackStateSeed, {
          status: "idle",
          transport: "audio_reference",
          audioSource,
          message: "Canonical audio playback completed."
        })
      );
    };

    const fallbackToTiming = (errorMessage: string | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      playbackAudio.pause();
      playbackAudio.src = "";
      cleanupPlaybackAudio();

      if (typeof durationMs === "number" && durationMs > 0 && speechPlaybackBridge.handledPlaybackKey === playbackKey) {
        beginTimingSpeechWindow(
          durationMs,
          playbackKey,
          speechReactionInput,
          errorMessage
        );
        return;
      }

      if (speechPlaybackBridge.handledPlaybackKey !== playbackKey) {
        return;
      }

      runtime.clearSpeechReaction();
      setSpeechPlaybackStatus(
        buildSpeechPlaybackState(playbackStateSeed, {
          status: "idle",
          transport: "none",
          audioSource,
          message: "Canonical audio reference was not browser-playable and no timing fallback was available.",
          error: errorMessage
        })
      );
    };

    const handlePlaying = (): void => {
      console.info("[SpeechPlayback] 'playing' event fired", {
        currentTime: playbackAudio.currentTime,
        duration: playbackAudio.duration,
        volume: playbackAudio.volume,
        muted: playbackAudio.muted,
        paused: playbackAudio.paused,
      });
      if (speechPlaybackBridge.handledPlaybackKey !== playbackKey) {
        return;
      }

      runtime.beginSpeechReaction(speechReactionInput);
      setSpeechPlaybackStatus(
        buildSpeechPlaybackState(playbackStateSeed, {
          status: "audio",
          transport: "audio_reference",
          audioSource,
          message: "Playing canonical audio reference."
        })
      );

      if (typeof durationMs === "number" && durationMs > 0) {
        clearSpeechPlaybackTimeout();
        speechPlaybackBridge.playbackTimeoutId = window.setTimeout(() => {
          finishPlayback();
        }, durationMs);
      }
    };

    const handleEnded = (): void => {
      console.info("[SpeechPlayback] 'ended' event fired", {
        currentTime: playbackAudio.currentTime,
        duration: playbackAudio.duration,
      });
      finishPlayback();
    };

    const handleError = (): void => {
      fallbackToTiming("Canonical audio reference failed to load in the browser.");
    };

    playbackAudio.addEventListener("playing", handlePlaying);
    playbackAudio.addEventListener("ended", handleEnded);
    playbackAudio.addEventListener("error", handleError);
    playbackAudio.addEventListener("loadedmetadata", () => {
      console.info("[SpeechPlayback] loadedmetadata", {
        duration: playbackAudio.duration,
        paused: playbackAudio.paused,
        muted: playbackAudio.muted,
        volume: playbackAudio.volume,
        readyState: playbackAudio.readyState,
        networkState: playbackAudio.networkState,
        src: playbackAudio.src,
      });
    });

    console.info("[SpeechPlayback] Attempting audio.play()", { audioSource, durationMs, playbackKey });
    void playbackAudio.play().then(() => {
      console.info("[SpeechPlayback] play() resolved successfully", {
        duration: playbackAudio.duration,
        currentTime: playbackAudio.currentTime,
        paused: playbackAudio.paused,
        volume: playbackAudio.volume,
        muted: playbackAudio.muted,
      });
    }).catch((error: unknown) => {
      console.warn("[SpeechPlayback] play() rejected:", error);
      fallbackToTiming(error instanceof Error ? error.message : "Canonical audio playback could not start.");
    });

    function resolveAudioPlaybackStartupTimeoutMs(): number {
      return AUDIO_PLAYBACK_STARTUP_TIMEOUT_MS;
    }
  }
}

function createIdleSpeechPlaybackState(): SpeechPlaybackState {
  return {
    status: "idle",
    transport: "none",
    playbackKey: null,
    message: "No canonical synthesis playback is active.",
    error: null,
    audioReference: null,
    audioSource: null,
    synthesisStatus: null,
    profileId: null,
    locale: null,
    utteranceDurationMs: null,
    text: null
  };
}

function buildSpeechPlaybackStateSeed(
  event: BackendSessionEventDocument,
  playbackKey: string
): SpeechPlaybackStateSeed {
  return {
    playbackKey,
    audioReference: normalizeOptionalText(event.synthesis?.audio_reference),
    synthesisStatus: normalizeOptionalText(event.synthesis?.status) ?? normalizeOptionalText(event.status),
    profileId: normalizeOptionalText(event.synthesis?.profile_id),
    locale: normalizeOptionalText(event.synthesis?.locale),
    utteranceDurationMs: event.synthesis?.timing?.utterance_duration_ms ?? null,
    text: normalizeOptionalText(event.synthesis?.text)
  };
}

function buildSpeechPlaybackState(
  playbackStateSeed: SpeechPlaybackStateSeed,
  overrides: Partial<SpeechPlaybackState>
): SpeechPlaybackState {
  return {
    status: overrides.status ?? "idle",
    transport: overrides.transport ?? "none",
    playbackKey: overrides.playbackKey ?? playbackStateSeed.playbackKey,
    message: overrides.message ?? "No canonical synthesis playback is active.",
    error: overrides.error ?? null,
    audioReference: overrides.audioReference ?? playbackStateSeed.audioReference,
    audioSource: overrides.audioSource ?? null,
    synthesisStatus: overrides.synthesisStatus ?? playbackStateSeed.synthesisStatus,
    profileId: overrides.profileId ?? playbackStateSeed.profileId,
    locale: overrides.locale ?? playbackStateSeed.locale,
    utteranceDurationMs: overrides.utteranceDurationMs ?? playbackStateSeed.utteranceDurationMs,
    text: overrides.text ?? playbackStateSeed.text
  };
}

function buildTimingPlaybackMessage(reason: SpeechAudioSourceResolutionReason): string {
  if (reason === "machine_local") {
    return "Backend published a machine-local audio_reference, so the bridge is using canonical timing metadata until a browser-safe URL is available.";
  }

  if (reason === "session_reference") {
    return "Backend published a session-scoped audio reference, so the bridge is using canonical timing metadata.";
  }

  return "No browser-playable audio reference was published, so the bridge is using canonical timing metadata.";
}

function buildUnavailablePlaybackMessage(reason: SpeechAudioSourceResolutionReason): string {
  if (reason === "machine_local") {
    return "Backend published a machine-local audio_reference, but the browser cannot open local filesystem paths from the shared shell.";
  }

  if (reason === "session_reference") {
    return "Backend published a session-scoped audio reference, but no timing metadata was available to drive playback in this shell.";
  }

  return "Canonical synthesis is present, but it has no browser-playable audio reference or timing metadata.";
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : null;
}

function resolveSpeechReactionInput(synthesis: BackendSpeechSynthesisDocument): AvatarSpeechReactionInput {
  return {
    utteranceDurationMs: synthesis.timing?.utterance_duration_ms ?? null,
    visemeSlots: synthesis.timing?.viseme_slots ?? []
  };
}

function buildSpeechSynthesisPlaybackKey(event: BackendSessionEventDocument | null): string | null {
  if (!event?.synthesis) {
    return null;
  }

  return [
    event.session_id,
    event.character_id,
    event.timestamp,
    event.status,
    event.synthesis.profile_id,
    event.synthesis.locale,
    event.synthesis.text,
    event.synthesis.audio_reference ?? ""
  ].join("|");
}

