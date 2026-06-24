import { useEffect, useState } from "react";
import { registerAudioOutputElement } from "./audioOutputControl";
import type {
  AvatarRuntimeBridge,
  AvatarSpeechReactionInput
} from "../avatar/runtime/avatarRuntime";
import type {
  BackendSpeechLipSyncPayloadDocument,
  BackendSpeechMouthCueTrackDocument,
  BackendSessionEventDocument,
  BackendSpeechSynthesisDocument,
  BackendSpeechVisemeSlotDocument
} from "../shared/types/character";
import {
  resolveSpeechSynthesisAudioSource,
  type SpeechAudioSourceResolutionReason
} from "./speechPlaybackAudioSource";

export type SpeechPlaybackStatus = "idle" | "audio" | "timing";
export type SpeechPlaybackTransport = "none" | "audio_reference" | "timing_window";

export interface SpeechPlaybackBundle {
  playbackKey: string;
  storedAt: string;
  profileId: string | null;
  locale: string | null;
  text: string | null;
  audioReference: string | null;
  audioSource: string | null;
  sourceResolutionReason: SpeechAudioSourceResolutionReason;
  utteranceDurationMs: number | null;
  visemeSlots: BackendSpeechVisemeSlotDocument[];
  lipSync: BackendSpeechLipSyncPayloadDocument | null;
}

interface SpeechPlaybackSnapshot {
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
  lipSyncDefaultTrackId: string | null;
  lipSyncTrackIds: string[];
  lipSyncTimingSource: string | null;
  lipSyncSourceSlotType: string | null;
  lastBundle: SpeechPlaybackBundle | null;
}

export type SpeechPlaybackState = SpeechPlaybackSnapshot & {
  replayLastBundle: () => void;
};

interface UseSpeechPlaybackBridgeOptions {
  runtime: AvatarRuntimeBridge;
  canonicalSynthesisEvent: BackendSessionEventDocument | null;
  latestAvailableSynthesisEvent: BackendSessionEventDocument | null;
  // Phase 1a: ordered segments of the current utterance. Defaults to empty,
  // in which case the bridge plays the single canonicalSynthesisEvent (legacy).
  canonicalSynthesisSegments?: BackendSessionEventDocument[];
  // When false, the bridge tracks lifecycle status (so non-avatar surfaces can
  // show playback state and still relay cross-window replays) but never starts
  // local audio/timing playback. Wire this to "is this the avatar surface?" so
  // a reply is voiced on exactly one page — no duplicate audio on control/
  // settings windows. Defaults to true (legacy single-surface behavior).
  playbackEnabled?: boolean;
  // Phase 2 increment 3: optional browser-safe override for a segment's audio
  // source, keyed by (utterance_id, segment_index). When it returns a URL
  // (a streamed blob: from the WebSocket transport), the bridge plays it
  // instead of resolving the backend audio_reference — saving the artifact
  // fetch round-trip. Returns null to fall back to the canonical reference.
  resolveSegmentAudioOverride?: (utteranceId: string | null, segmentIndex: number | null) => string | null;
  // True once the lifecycle snapshot has loaded for this surface. Whatever
  // utterance is already present at that moment was synthesized BEFORE this
  // surface was live (it is a snapshot replay, not a fresh reply), so the bridge
  // adopts it as already-played instead of auto-voicing the last reply on
  // startup. Only utterances that begin AFTER that baseline are voiced. Defaults
  // to false (no suppression): a caller that does not pass this keeps the legacy
  // behavior of playing whatever is present on first render.
  lifecycleReady?: boolean;
}

interface SpeechPlaybackStateSeed {
  bundle: SpeechPlaybackBundle;
  synthesisStatus: string | null;
}

const AUDIO_PLAYBACK_STARTUP_TIMEOUT_MS = 8000;
const SHARED_SPEECH_REPLAY_STORAGE_KEY = "nikof.speechPlaybackReplayRequest";

interface SharedSpeechReplayRequest {
  senderWindowId: string;
  replayPlaybackKey: string;
  synthesisStatus: string | null;
  bundle: SpeechPlaybackBundle;
}

export function useSpeechPlaybackBridge({
  runtime,
  canonicalSynthesisEvent,
  latestAvailableSynthesisEvent,
  canonicalSynthesisSegments,
  playbackEnabled = true,
  resolveSegmentAudioOverride,
  lifecycleReady = false
}: UseSpeechPlaybackBridgeOptions): SpeechPlaybackState {
  const [speechPlaybackStatus, setSpeechPlaybackStatus] = useState<SpeechPlaybackSnapshot>(() => createIdleSpeechPlaybackState(null));
  const [speechPlaybackWindowId] = useState(() => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return `speech-playback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  });
  const [speechPlaybackBridge] = useState(() => ({
    activeAudio: null as HTMLAudioElement | null,
    cleanupActiveAudio: null as (() => void) | null,
    playbackTimeoutId: null as number | null,
    handledPlaybackKey: null as string | null,
    hasResolvedInitialBundle: false,
    // Set once the first lifecycle snapshot has loaded; whatever utterance is
    // present then is adopted as already-played (mount-time replay suppression).
    hasBaselinedInitialUtterance: false,
    pendingPlaybackStateSeed: null as SpeechPlaybackStateSeed | null,
    pendingTimingMessage: null as string | null,
    // Phase 1a playlist cursor.
    activeUtteranceId: null as string | null,
    segmentCursor: 0,
    utteranceSegments: [] as BackendSessionEventDocument[]
  }));

  useEffect(() => {
    return () => {
      stopSpeechPlayback(true);
    };
  }, []);

  useEffect(() => {
    const playbackKey = buildSpeechSynthesisPlaybackKey(latestAvailableSynthesisEvent);

    if (!speechPlaybackBridge.hasResolvedInitialBundle) {
      speechPlaybackBridge.hasResolvedInitialBundle = true;

      if (!playbackKey || !latestAvailableSynthesisEvent?.synthesis) {
        return;
      }

      const initialAudioResolution = resolveSpeechSynthesisAudioSource(latestAvailableSynthesisEvent.synthesis.audio_reference);
      const initialBundle = buildSpeechPlaybackBundle(latestAvailableSynthesisEvent, playbackKey, initialAudioResolution);
      speechPlaybackBridge.handledPlaybackKey = playbackKey;
      setSpeechPlaybackStatus((currentState) =>
        currentState.lastBundle?.playbackKey === initialBundle.playbackKey
          ? currentState
          : createIdleSpeechPlaybackState(initialBundle)
      );
      return;
    }

    if (!playbackKey || !latestAvailableSynthesisEvent?.synthesis) {
      return;
    }

    const audioResolution = resolveSpeechSynthesisAudioSource(latestAvailableSynthesisEvent.synthesis.audio_reference);
    const latestBundle = buildSpeechPlaybackBundle(latestAvailableSynthesisEvent, playbackKey, audioResolution);

    setSpeechPlaybackStatus((currentState) => {
      if (currentState.lastBundle?.playbackKey === latestBundle.playbackKey) {
        return currentState;
      }

      if (currentState.status === "idle" && currentState.playbackKey === null) {
        return createIdleSpeechPlaybackState(latestBundle);
      }

      return {
        ...currentState,
        lastBundle: latestBundle,
        lipSyncDefaultTrackId: latestBundle.lipSync?.default_track_id ?? null,
        lipSyncTrackIds: latestBundle.lipSync?.mouth_cue_tracks.map((track) => track.track_id) ?? [],
        lipSyncTimingSource: latestBundle.lipSync?.debug?.timing_source ?? null,
        lipSyncSourceSlotType: latestBundle.lipSync?.debug?.source_slot_type ?? null
      };
    });
  }, [latestAvailableSynthesisEvent]);

  useEffect(() => {
    if (!playbackEnabled) {
      // Non-avatar surface: do not voice replies here. Lifecycle status is
      // still tracked by the latestAvailableSynthesisEvent effect above.
      return;
    }

    const segments = resolvePlaylistSegments(canonicalSynthesisSegments, canonicalSynthesisEvent);

    // Mount-time replay suppression: the first time the lifecycle snapshot is
    // ready, adopt whatever utterance it already contains as already-played
    // rather than auto-voicing the last reply on startup. This is the snapshot
    // (not a live reply), and it is keyed to the snapshot being READY rather than
    // the first effect run, because the snapshot loads asynchronously after mount
    // (the first run usually sees an empty snapshot). Utterances that begin after
    // this baseline are voiced normally.
    if (lifecycleReady && !speechPlaybackBridge.hasBaselinedInitialUtterance) {
      speechPlaybackBridge.hasBaselinedInitialUtterance = true;
      if (segments.length > 0) {
        speechPlaybackBridge.activeUtteranceId = resolveUtteranceIdentity(segments);
        speechPlaybackBridge.utteranceSegments = segments;
        speechPlaybackBridge.segmentCursor = segments.length;
        const lastSegmentKey = buildSpeechSynthesisPlaybackKey(segments[segments.length - 1] ?? null);
        if (lastSegmentKey) {
          speechPlaybackBridge.handledPlaybackKey = lastSegmentKey;
        }
        return;
      }
    }

    if (segments.length === 0) {
      speechPlaybackBridge.activeUtteranceId = null;
      speechPlaybackBridge.segmentCursor = 0;
      speechPlaybackBridge.utteranceSegments = [];
      stopSpeechPlayback(true);
      return;
    }

    const utteranceId = resolveUtteranceIdentity(segments);
    if (utteranceId !== speechPlaybackBridge.activeUtteranceId) {
      // New utterance: stop current playback and restart the segment cursor.
      // handledPlaybackKey is intentionally NOT cleared — per-segment dedup in
      // playSegmentAtCursor preserves the mount-time auto-play suppression (the
      // initial-bundle effect pre-sets it to the latest event's key).
      stopSpeechPlayback(false);
      speechPlaybackBridge.activeUtteranceId = utteranceId;
      speechPlaybackBridge.segmentCursor = 0;
    }

    speechPlaybackBridge.utteranceSegments = segments;
    playSegmentAtCursor();
  }, [canonicalSynthesisSegments, canonicalSynthesisEvent, runtime, speechPlaybackBridge, playbackEnabled, lifecycleReady]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    // Replay is initiated from the control surface window, so relay it to any
    // display-only windows that are mounted against the same session shell.
    const handleStorage = (event: StorageEvent): void => {
      if (event.key !== SHARED_SPEECH_REPLAY_STORAGE_KEY || !event.newValue) {
        return;
      }

      let replayRequest: SharedSpeechReplayRequest | null = null;

      try {
        replayRequest = JSON.parse(event.newValue) as SharedSpeechReplayRequest;
      } catch {
        return;
      }

      if (!replayRequest || replayRequest.senderWindowId === speechPlaybackWindowId) {
        return;
      }

      beginReplayPlayback(replayRequest.bundle, replayRequest.replayPlaybackKey, replayRequest.synthesisStatus);
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, [speechPlaybackWindowId]);

  return {
    ...speechPlaybackStatus,
    replayLastBundle
  };

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
      setSpeechPlaybackStatus((currentState) => createIdleSpeechPlaybackState(currentState.lastBundle));
    }
  }

  function playSegmentAtCursor(): void {
    const segments = speechPlaybackBridge.utteranceSegments;
    const segmentEvent = segments[speechPlaybackBridge.segmentCursor] ?? null;
    const playbackKey = buildSpeechSynthesisPlaybackKey(segmentEvent);

    if (!playbackKey || !segmentEvent?.synthesis) {
      // Segment not delivered yet (background synthesis still running); a later
      // snapshot update will re-run the effect and play it when it arrives.
      return;
    }

    if (speechPlaybackBridge.handledPlaybackKey === playbackKey) {
      return;
    }

    speechPlaybackBridge.handledPlaybackKey = playbackKey;

    // Prefer a streamed blob: URL for this segment (WebSocket transport) over a
    // fetch of the canonical audio_reference; fall back when none has arrived.
    const streamedAudioUrl = resolveSegmentAudioOverride?.(
      normalizeOptionalText(segmentEvent.synthesis.utterance_id),
      segmentEvent.synthesis.segment_index ?? null
    ) ?? null;
    const audioResolution = resolveSpeechSynthesisAudioSource(
      streamedAudioUrl ?? segmentEvent.synthesis.audio_reference
    );
    const playbackBundle = buildSpeechPlaybackBundle(segmentEvent, playbackKey, audioResolution);
    const playbackStateSeed = buildSpeechPlaybackStateSeed(playbackBundle, segmentEvent);
    const speechReactionInput = resolveSpeechReactionInput(playbackBundle);
    const durationMs = speechReactionInput.utteranceDurationMs;
    const isFinalSegment = segmentEvent.synthesis.is_final ?? true;

    if (playbackBundle.audioSource) {
      speechPlaybackBridge.pendingPlaybackStateSeed = playbackStateSeed;
      speechPlaybackBridge.pendingTimingMessage = null;
      beginAudioSpeechPlayback(playbackBundle, durationMs, playbackKey, speechReactionInput, isFinalSegment);
      return;
    }

    if (typeof durationMs === "number" && durationMs > 0) {
      speechPlaybackBridge.pendingPlaybackStateSeed = playbackStateSeed;
      speechPlaybackBridge.pendingTimingMessage = buildTimingPlaybackMessage(audioResolution.reason);
      beginTimingSpeechWindow(durationMs, playbackKey, speechReactionInput, isFinalSegment);
      return;
    }

    // Neither audio nor timing for this segment: advance unless it is the last.
    speechPlaybackBridge.pendingPlaybackStateSeed = null;
    speechPlaybackBridge.pendingTimingMessage = null;
    if (!isFinalSegment) {
      advanceToNextSegment(playbackKey);
      return;
    }
    runtime.clearSpeechReaction();
    setSpeechPlaybackStatus(
      buildSpeechPlaybackState(playbackStateSeed, {
        status: "idle",
        transport: "none",
        message: buildUnavailablePlaybackMessage(audioResolution.reason)
      })
    );
  }

  function advanceToNextSegment(completedPlaybackKey: string): void {
    // Only advance if this completion belongs to the segment we are tracking
    // (guards against a superseding utterance having reset the cursor).
    if (speechPlaybackBridge.handledPlaybackKey !== completedPlaybackKey) {
      return;
    }
    speechPlaybackBridge.segmentCursor += 1;
    playSegmentAtCursor();
  }

  function beginTimingSpeechWindow(
    durationMs: number,
    playbackKey: string,
    speechReactionInput: AvatarSpeechReactionInput,
    isFinalSegment: boolean,
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

      speechPlaybackBridge.playbackTimeoutId = null;

      if (!isFinalSegment) {
        advanceToNextSegment(playbackKey);
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
    }, durationMs);
  }

  function beginAudioSpeechPlayback(
    playbackBundle: SpeechPlaybackBundle,
    durationMs: number | null,
    playbackKey: string,
    speechReactionInput: AvatarSpeechReactionInput,
    isFinalSegment: boolean
  ): void {
    const playbackStateSeed = speechPlaybackBridge.pendingPlaybackStateSeed;

    if (!playbackStateSeed) {
      stopSpeechPlayback(true);
      return;
    }

    clearSpeechPlaybackTimeout();
    releaseSpeechAudio();

    if (!playbackBundle.audioSource) {
      stopSpeechPlayback(true);
      return;
    }

    const playbackAudio = new Audio(playbackBundle.audioSource);
    playbackAudio.volume = 1.0;
    // Honour the window's audio-out mute toggle (and keep this element in sync if
    // it is toggled mid-utterance).
    const unregisterAudioOutput = registerAudioOutputElement(playbackAudio);
    let settled = false;
    let playbackStarted = false;

    speechPlaybackBridge.activeAudio = playbackAudio;
    setSpeechPlaybackStatus(
      buildSpeechPlaybackState(playbackStateSeed, {
        status: "audio",
        transport: "audio_reference",
          audioSource: playbackBundle.audioSource,
        message: "Loading canonical audio reference."
      })
    );

    const cleanupPlaybackAudio = (): void => {
      playbackAudio.removeEventListener("play", handlePlay);
      playbackAudio.removeEventListener("playing", handlePlaying);
      playbackAudio.removeEventListener("timeupdate", handleTimeUpdate);
      playbackAudio.removeEventListener("ended", handleEnded);
      playbackAudio.removeEventListener("error", handleError);
      unregisterAudioOutput();
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

      if (!isFinalSegment) {
        // Keep the avatar in its speaking reaction and play the next segment.
        advanceToNextSegment(playbackKey);
        return;
      }

      runtime.clearSpeechReaction();
      setSpeechPlaybackStatus(
        buildSpeechPlaybackState(playbackStateSeed, {
          status: "idle",
          transport: "audio_reference",
          audioSource: playbackBundle.audioSource,
          message: "Canonical audio playback completed."
        })
      );
    };

    const startPlaybackReaction = (message: string): void => {
      if (settled || playbackStarted || speechPlaybackBridge.handledPlaybackKey !== playbackKey) {
        return;
      }

      playbackStarted = true;
      clearSpeechPlaybackTimeout();
      // Prefer the real browser-decoded clip length when available so mouth
      // playback does not outlive the audio because of backend timing drift.
      const resolvedAudioDurationMs = resolveAudioPlaybackDurationMs(playbackAudio);
      const effectiveDurationMs = resolveEffectiveSpeechReactionDurationMs(durationMs, resolvedAudioDurationMs);
      runtime.beginSpeechReaction({
        ...speechReactionInput,
        utteranceDurationMs: effectiveDurationMs
      });
      setSpeechPlaybackStatus(
        buildSpeechPlaybackState(playbackStateSeed, {
          status: "audio",
          transport: "audio_reference",
          audioSource: playbackBundle.audioSource,
          message,
          utteranceDurationMs: effectiveDurationMs
        })
      );

      if (typeof effectiveDurationMs === "number" && effectiveDurationMs > 0) {
        speechPlaybackBridge.playbackTimeoutId = window.setTimeout(() => {
          finishPlayback();
        }, effectiveDurationMs);
      }
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
          isFinalSegment,
          errorMessage
        );
        return;
      }

      if (speechPlaybackBridge.handledPlaybackKey !== playbackKey) {
        return;
      }

      if (!isFinalSegment) {
        // Cannot play this non-final segment (no audio, no timing) — skip ahead
        // rather than stalling the utterance.
        advanceToNextSegment(playbackKey);
        return;
      }

      runtime.clearSpeechReaction();
      setSpeechPlaybackStatus(
        buildSpeechPlaybackState(playbackStateSeed, {
          status: "idle",
          transport: "none",
          audioSource: playbackBundle.audioSource,
          message: "Canonical audio reference was not browser-playable and no timing fallback was available.",
          error: errorMessage
        })
      );
    };

    const handlePlay = (): void => {
      startPlaybackReaction("Playing canonical audio reference.");
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

      startPlaybackReaction("Playing canonical audio reference.");
    };

    const handleTimeUpdate = (): void => {
      if (playbackAudio.currentTime > 0) {
        startPlaybackReaction("Playing canonical audio reference.");
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

    playbackAudio.addEventListener("play", handlePlay);
    playbackAudio.addEventListener("playing", handlePlaying);
    playbackAudio.addEventListener("timeupdate", handleTimeUpdate);
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

    const audioSource = playbackBundle.audioSource;
    console.info("[SpeechPlayback] Attempting audio.play()", { audioSource, durationMs, playbackKey });
    void playbackAudio.play().then(() => {
      console.info("[SpeechPlayback] play() resolved successfully", {
        duration: playbackAudio.duration,
        currentTime: playbackAudio.currentTime,
        paused: playbackAudio.paused,
        volume: playbackAudio.volume,
        muted: playbackAudio.muted,
      });
      startPlaybackReaction("Playing canonical audio reference.");
    }).catch((error: unknown) => {
      console.warn("[SpeechPlayback] play() rejected:", error);
      fallbackToTiming(error instanceof Error ? error.message : "Canonical audio playback could not start.");
    });

    function resolveAudioPlaybackStartupTimeoutMs(): number {
      return AUDIO_PLAYBACK_STARTUP_TIMEOUT_MS;
    }
  }

  function beginReplayPlayback(
    playbackBundle: SpeechPlaybackBundle,
    replayPlaybackKey: string,
    synthesisStatus: string | null
  ): void {
    if (!playbackEnabled) {
      // Non-avatar surface: relay-only. replayLastBundle still broadcasts the
      // request to the avatar window via localStorage; we just don't voice it
      // here. Inbound storage relays are likewise ignored on this surface.
      return;
    }

    const playbackStateSeed: SpeechPlaybackStateSeed = {
      bundle: playbackBundle,
      synthesisStatus
    };
    const speechReactionInput = resolveSpeechReactionInput(playbackBundle);
    const durationMs = speechReactionInput.utteranceDurationMs;

    stopSpeechPlayback(false);
    speechPlaybackBridge.handledPlaybackKey = replayPlaybackKey;
    speechPlaybackBridge.pendingPlaybackStateSeed = playbackStateSeed;
    speechPlaybackBridge.pendingTimingMessage = buildTimingPlaybackMessage(playbackBundle.sourceResolutionReason);

    if (playbackBundle.audioSource) {
      beginAudioSpeechPlayback(playbackBundle, durationMs, replayPlaybackKey, speechReactionInput, true);
      return;
    }

    if (typeof durationMs === "number" && durationMs > 0) {
      beginTimingSpeechWindow(durationMs, replayPlaybackKey, speechReactionInput, true);
    }
  }

  function replayLastBundle(): void {
    const lastBundle = speechPlaybackStatus.lastBundle;
    if (!lastBundle) {
      return;
    }

    const replayPlaybackKey = `${lastBundle.playbackKey}|replay|${Date.now()}`;
    beginReplayPlayback(lastBundle, replayPlaybackKey, speechPlaybackStatus.synthesisStatus);

    if (typeof window !== "undefined") {
      const replayRequest: SharedSpeechReplayRequest = {
        senderWindowId: speechPlaybackWindowId,
        replayPlaybackKey,
        synthesisStatus: speechPlaybackStatus.synthesisStatus,
        bundle: lastBundle
      };

      window.localStorage.setItem(SHARED_SPEECH_REPLAY_STORAGE_KEY, JSON.stringify(replayRequest));
      window.localStorage.removeItem(SHARED_SPEECH_REPLAY_STORAGE_KEY);
    }
  }
}

function createIdleSpeechPlaybackState(lastBundle: SpeechPlaybackBundle | null): SpeechPlaybackSnapshot {
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
    text: null,
    lipSyncDefaultTrackId: lastBundle?.lipSync?.default_track_id ?? null,
    lipSyncTrackIds: lastBundle?.lipSync?.mouth_cue_tracks.map((track) => track.track_id) ?? [],
    lipSyncTimingSource: lastBundle?.lipSync?.debug?.timing_source ?? null,
    lipSyncSourceSlotType: lastBundle?.lipSync?.debug?.source_slot_type ?? null,
    lastBundle
  };
}

function buildSpeechPlaybackStateSeed(
  bundle: SpeechPlaybackBundle,
  event: BackendSessionEventDocument
): SpeechPlaybackStateSeed {
  return {
    bundle,
    synthesisStatus: normalizeOptionalText(event.synthesis?.status) ?? normalizeOptionalText(event.status)
  };
}

function buildSpeechPlaybackState(
  playbackStateSeed: SpeechPlaybackStateSeed,
  overrides: Partial<SpeechPlaybackSnapshot>
): SpeechPlaybackSnapshot {
  const bundle = playbackStateSeed.bundle;
  return {
    status: overrides.status ?? "idle",
    transport: overrides.transport ?? "none",
    playbackKey: overrides.playbackKey ?? bundle.playbackKey,
    message: overrides.message ?? "No canonical synthesis playback is active.",
    error: overrides.error ?? null,
    audioReference: overrides.audioReference ?? bundle.audioReference,
    audioSource: overrides.audioSource ?? null,
    synthesisStatus: overrides.synthesisStatus ?? playbackStateSeed.synthesisStatus,
    profileId: overrides.profileId ?? bundle.profileId,
    locale: overrides.locale ?? bundle.locale,
    utteranceDurationMs: overrides.utteranceDurationMs ?? bundle.utteranceDurationMs,
    text: overrides.text ?? bundle.text,
    lipSyncDefaultTrackId: overrides.lipSyncDefaultTrackId ?? bundle.lipSync?.default_track_id ?? null,
    lipSyncTrackIds: overrides.lipSyncTrackIds ?? bundle.lipSync?.mouth_cue_tracks.map((track) => track.track_id) ?? [],
    lipSyncTimingSource: overrides.lipSyncTimingSource ?? bundle.lipSync?.debug?.timing_source ?? null,
    lipSyncSourceSlotType: overrides.lipSyncSourceSlotType ?? bundle.lipSync?.debug?.source_slot_type ?? null,
    lastBundle: overrides.lastBundle ?? bundle
  };
}

function buildSpeechPlaybackBundle(
  event: BackendSessionEventDocument,
  playbackKey: string,
  audioResolution: ReturnType<typeof resolveSpeechSynthesisAudioSource>
): SpeechPlaybackBundle {
  return {
    playbackKey,
    storedAt: new Date().toISOString(),
    profileId: normalizeOptionalText(event.synthesis?.profile_id),
    locale: normalizeOptionalText(event.synthesis?.locale),
    text: normalizeOptionalText(event.synthesis?.text),
    audioReference: normalizeOptionalText(event.synthesis?.audio_reference),
    audioSource: audioResolution.audioSource,
    sourceResolutionReason: audioResolution.reason,
    utteranceDurationMs: event.synthesis?.timing?.utterance_duration_ms ?? null,
    visemeSlots: event.synthesis?.timing?.viseme_slots ?? [],
    lipSync: event.synthesis?.timing?.lip_sync ?? null
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

function resolveAudioPlaybackDurationMs(audio: HTMLAudioElement): number | null {
  const durationSeconds = audio.duration;

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }

  return durationSeconds * 1000;
}

function resolveEffectiveSpeechReactionDurationMs(
  backendDurationMs: number | null,
  audioDurationMs: number | null
): number | null {
  if (typeof backendDurationMs === "number" && backendDurationMs > 0 && typeof audioDurationMs === "number" && audioDurationMs > 0) {
    return Math.min(backendDurationMs, audioDurationMs);
  }

  if (typeof audioDurationMs === "number" && audioDurationMs > 0) {
    return audioDurationMs;
  }

  if (typeof backendDurationMs === "number" && backendDurationMs > 0) {
    return backendDurationMs;
  }

  return null;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : null;
}

function resolveSpeechReactionInput(bundle: SpeechPlaybackBundle): AvatarSpeechReactionInput {
  return {
    utteranceDurationMs: bundle.utteranceDurationMs,
    visemeSlots: bundle.visemeSlots,
    mouthCueTrack: resolvePreferredMouthCueTrack(bundle.lipSync)
  };
}

function resolvePreferredMouthCueTrack(
  lipSync: BackendSpeechLipSyncPayloadDocument | null
): BackendSpeechMouthCueTrackDocument | null {
  if (!lipSync || lipSync.mouth_cue_tracks.length === 0) {
    return null;
  }

  const defaultTrackId = normalizeOptionalText(lipSync.default_track_id);
  if (defaultTrackId) {
    const matchingTrack = lipSync.mouth_cue_tracks.find((track) => track.track_id === defaultTrackId);
    if (matchingTrack) {
      return matchingTrack;
    }
  }

  return lipSync.mouth_cue_tracks[0] ?? null;
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

/**
 * Choose the ordered events to play as one utterance. A segmented reply (its
 * first event carries a utterance_id) plays as a playlist; otherwise the bridge
 * falls back to the single canonical event (legacy behavior, incl. the
 * published-operator-command fallback).
 */
function resolvePlaylistSegments(
  segments: BackendSessionEventDocument[] | undefined,
  fallbackEvent: BackendSessionEventDocument | null
): BackendSessionEventDocument[] {
  if (segments && segments.length > 0 && (segments[0].synthesis?.utterance_id ?? null)) {
    return segments;
  }

  return fallbackEvent ? [fallbackEvent] : [];
}

/**
 * Stable identity for the current utterance: the utterance_id when segmented,
 * otherwise the single event's playback key so a changed event resets playback.
 */
function resolveUtteranceIdentity(segments: BackendSessionEventDocument[]): string | null {
  const first = segments[0] ?? null;
  return first?.synthesis?.utterance_id ?? buildSpeechSynthesisPlaybackKey(first);
}

