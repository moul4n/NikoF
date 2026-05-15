import { readFile } from "fs/promises";
import {
  startSessionAnimationLiveConsumption,
  type ConsumedSessionAnimationSnapshot
} from "../../frontend/src/avatar/loaders/sessionAnimation.js";
import {
  cloneDefaultBaseAnimationCommand,
  resolveSharedSemanticAnimationPayload,
  resolveSharedSemanticAnimationPayloadFromRuntimeDocuments,
  type SharedAnimationRuntimeSidecarDocument
} from "../../frontend/src/avatar/runtime/defaultBaseAnimation.js";
import { resolveBaseAnimationMotionProfile } from "../../frontend/src/avatar/runtime/baseAnimationMotionProfile.js";
import type {
  BackendAnimationCommandDocument,
  BackendSessionAnimationSnapshotDocument,
  SemanticAnimationCommand,
  SemanticAnimationMotionProfile
} from "../../frontend/src/shared/types/animation.js";

type FrontendAvatarIdleDefaultRuntimeSnapshot = {
  backend_session_animation_surface: {
    active_character_id: string;
    snapshot_document: BackendSessionAnimationSnapshotDocument;
    updated_snapshot_document: BackendSessionAnimationSnapshotDocument;
  };
  promoted_idle_asset: {
    semantic_id: string;
    derived_duration_ms?: number;
  };
  frontend_source_surface: {
    app_mentions_idle_default_sidecar_path: boolean;
    app_mentions_animation_asset_root: boolean;
    runtime_mentions_idle_default_sidecar_path: boolean;
    runtime_mentions_animation_asset_root: boolean;
    runtime_load_path_seeds_default_idle: boolean;
    avatar_runtime_wires_humanoid_channel_playback: boolean;
    loader_fetches_session_animation_snapshot: boolean;
    loader_live_url_reuses_animation_route: boolean;
    humanoid_playback_factory_present: boolean;
    humanoid_playback_requires_unity_humanoid_channel_space: boolean;
    humanoid_playback_binds_representative_channels: boolean;
  };
  generated_runtime_payload_surface: {
    idle_default: GeneratedRuntimePayloadSurface;
    speak_loop: GeneratedRuntimePayloadSurface;
  };
};

type ExportedChannelSummary = {
  channel_space: string | null;
  channel_count: number;
  playback_sample_count: number | null;
  representative_channels: Array<{
    normalized_name: string;
    sample_count: number;
    min_value: number | null;
    max_value: number | null;
  }>;
};

type GeneratedRuntimePayloadSurface = {
  runtime_document: SharedAnimationRuntimeSidecarDocument;
  exported_channel_summary: ExportedChannelSummary;
};

const REPRESENTATIVE_CHANNEL_NAMES = ["chest.front_back", "head.nod.down_up", "head.turn.left_right"];

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();
  onmessage: ((event: { data?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(eventName: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
  }

  emit(eventName: string, data?: string): void {
    this.listeners.get(eventName)?.forEach((listener) => {
      listener({ data });
    });

    if (eventName === "message") {
      this.onmessage?.({ data });
    }
  }

  close(): void {
    this.closed = true;
  }
}

function resolveFrontendPlaybackMode(mode: string, loop: boolean): "loop" | "once" | string {
  if (loop || mode === "loop") {
    return "loop";
  }

  if (mode === "oneshot") {
    return "once";
  }

  return mode;
}

function buildRuntimeCommand(command: BackendAnimationCommandDocument): SemanticAnimationCommand {
  return {
    id: command.semantic_id,
    source: "shared",
    playback: resolveFrontendPlaybackMode(command.playback.mode, command.playback.loop) === "once" ? "once" : "loop",
    durationMs: command.playback.expected_duration_ms ?? undefined
  };
}

function areMotionProfilesEqual(
  left: SemanticAnimationMotionProfile | null,
  right: SemanticAnimationMotionProfile | null
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.speedMultiplier === right.speedMultiplier &&
    left.bobAmplitude === right.bobAmplitude &&
    left.secondaryBobAmplitude === right.secondaryBobAmplitude &&
    left.leanAmplitude === right.leanAmplitude &&
    left.nodAmplitude === right.nodAmplitude &&
    left.yawAmplitude === right.yawAmplitude
  );
}

function exportedChannelSummaryHasRepresentativeCoverage(summary: ExportedChannelSummary): boolean {
  return REPRESENTATIVE_CHANNEL_NAMES.every((normalizedName) =>
    summary.representative_channels.some((channel) => channel.normalized_name === normalizedName)
  );
}

function exportedChannelSummaryMatchesPlaybackSamples(summary: ExportedChannelSummary): boolean {
  if (summary.playback_sample_count === null) {
    return false;
  }

  return summary.representative_channels.every((channel) => channel.sample_count === summary.playback_sample_count);
}

function exportedChannelSummaryShowsVariation(summary: ExportedChannelSummary): boolean {
  return summary.representative_channels.every((channel) => {
    if (channel.min_value === null || channel.max_value === null) {
      return false;
    }

    return channel.max_value !== channel.min_value;
  });
}

async function main(): Promise<void> {
  const snapshotPath = process.argv[2];

  if (!snapshotPath) {
    throw new Error("Expected a frontend avatar idle.default snapshot path argument.");
  }

  const seamSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as FrontendAvatarIdleDefaultRuntimeSnapshot;
  const backendSnapshot = seamSnapshot.backend_session_animation_surface.snapshot_document;
  const updatedBackendSnapshot = seamSnapshot.backend_session_animation_surface.updated_snapshot_document;
  const backendDefaultIdleCommand = backendSnapshot.command;
  const backendPlaybackMode = resolveFrontendPlaybackMode(
    backendDefaultIdleCommand.playback.mode,
    backendDefaultIdleCommand.playback.loop
  );
  const backendExpectedDurationMs =
    backendDefaultIdleCommand.playback.expected_duration_ms ?? seamSnapshot.promoted_idle_asset.derived_duration_ms ?? null;
  const baseAnimation = cloneDefaultBaseAnimationCommand();
  const runtimePayload = resolveSharedSemanticAnimationPayload(baseAnimation);
  const idleRuntimeMotionProfile = runtimePayload ? resolveBaseAnimationMotionProfile(runtimePayload) : null;
  const updatedRuntimeCommand = buildRuntimeCommand(updatedBackendSnapshot.command);
  const generatedIdleRuntimeDocument = seamSnapshot.generated_runtime_payload_surface.idle_default.runtime_document;
  const generatedSpeakRuntimeDocument = seamSnapshot.generated_runtime_payload_surface.speak_loop.runtime_document;
  const generatedIdlePayload = resolveSharedSemanticAnimationPayloadFromRuntimeDocuments(baseAnimation, [
    generatedIdleRuntimeDocument
  ]);
  const generatedSpeakPayload = resolveSharedSemanticAnimationPayloadFromRuntimeDocuments(updatedRuntimeCommand, [
    generatedSpeakRuntimeDocument
  ]);
  const generatedSpeakMotionProfile = generatedSpeakPayload ? resolveBaseAnimationMotionProfile(generatedSpeakPayload) : null;
  const requestedUrls: string[] = [];
  const observedSnapshots: Array<{ deliveryMode: string; snapshot: ConsumedSessionAnimationSnapshot }> = [];
  const observedDeliveryModes: string[] = [];
  let resolveLiveSnapshot: ((snapshot: ConsumedSessionAnimationSnapshot) => void) | null = null;
  const liveSnapshotPromise = new Promise<ConsumedSessionAnimationSnapshot>((resolve) => {
    resolveLiveSnapshot = resolve;
  });

  Object.assign(globalThis, {
    window: {
      EventSource: FakeEventSource,
      location: {
        origin: "http://localhost:4173"
      }
    }
  });

  const liveSubscription = await startSessionAnimationLiveConsumption({
    fetcher: async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const payload = requestedUrls.length === 1 ? backendSnapshot : updatedBackendSnapshot;

      return {
        ok: true,
        status: 200,
        json: async () => payload
      } as Response;
    },
    onSnapshot: (snapshot, deliveryMode) => {
      observedSnapshots.push({ deliveryMode, snapshot });
      if (deliveryMode === "live") {
        resolveLiveSnapshot?.(snapshot);
      }
    },
    onDeliveryModeChange: (deliveryMode) => {
      observedDeliveryModes.push(deliveryMode);
    }
  });

  const liveEventSource = FakeEventSource.instances[0];
  if (!liveEventSource) {
    throw new Error("Session animation live consumption did not create an EventSource instance.");
  }

  liveEventSource.emit("open");
  liveEventSource.emit("session.animation", JSON.stringify(updatedBackendSnapshot));

  const liveSnapshot = await liveSnapshotPromise;
  liveSubscription.close();

  const result = {
    runtime_default_idle: {
      backend_default_idle_command: {
        character_id: backendDefaultIdleCommand.character_id,
        semantic_id: backendDefaultIdleCommand.semantic_id,
        selected_source: backendDefaultIdleCommand.resolution.selected_source,
        playback_mode: backendPlaybackMode,
        expected_duration_ms: backendExpectedDurationMs
      },
      base_animation: baseAnimation,
      runtime_payload: runtimePayload,
      backend_surface_targets_active_character:
        backendDefaultIdleCommand.character_id === seamSnapshot.backend_session_animation_surface.active_character_id,
      backend_default_idle_is_shared_library: backendDefaultIdleCommand.resolution.selected_source === "shared_library",
      backend_default_idle_avoids_fallback: backendDefaultIdleCommand.resolution.fallback_applied === false,
      base_animation_matches_backend_semantic_id: baseAnimation.id === backendDefaultIdleCommand.semantic_id,
      base_animation_uses_shared_source: baseAnimation.source === "shared",
      base_animation_matches_backend_playback: baseAnimation.playback === backendPlaybackMode,
      runtime_payload_resolves: runtimePayload !== null,
      runtime_payload_matches_backend_semantic_id: runtimePayload?.semanticId === backendDefaultIdleCommand.semantic_id,
      runtime_payload_matches_backend_playback: runtimePayload?.playback === backendPlaybackMode,
      runtime_payload_matches_backend_duration:
        backendExpectedDurationMs === null ? runtimePayload !== null : runtimePayload?.durationMs === backendExpectedDurationMs
    },
    live_loader_runtime: {
      snapshot_fetch_urls: requestedUrls,
      live_event_source_url: liveEventSource.url,
      live_mode_observed: observedDeliveryModes.includes("live"),
      initial_snapshot_delivery_mode: observedSnapshots[0]?.deliveryMode ?? null,
      initial_snapshot_semantic_id: observedSnapshots[0]?.snapshot.semanticCommand.id ?? null,
      live_snapshot_semantic_id: liveSnapshot.semanticCommand.id,
      live_snapshot_lifecycle_state: liveSnapshot.lifecycleState,
      live_snapshot_matches_backend_updated_character:
        liveSnapshot.characterId === updatedBackendSnapshot.active_character_id,
      snapshot_fetch_stays_on_snapshot_route: requestedUrls.every((url) => /\/session\/animation$/.test(url)),
      live_event_source_reuses_animation_route: /\/session\/animation$/.test(liveEventSource.url),
      live_event_consumed_direct_payload: requestedUrls.length === 1,
      live_event_promoted_updated_snapshot: liveSnapshot.semanticCommand.id === updatedBackendSnapshot.command.semantic_id,
      live_event_source_closed_on_cleanup: liveEventSource.closed
    },
    source_path_independence: {
      runtime_load_path_seeds_default_idle: seamSnapshot.frontend_source_surface.runtime_load_path_seeds_default_idle,
      app_uses_idle_asset_path_hack:
        seamSnapshot.frontend_source_surface.app_mentions_idle_default_sidecar_path ||
        seamSnapshot.frontend_source_surface.app_mentions_animation_asset_root,
      runtime_uses_idle_asset_path_hack:
        seamSnapshot.frontend_source_surface.runtime_mentions_idle_default_sidecar_path ||
        seamSnapshot.frontend_source_surface.runtime_mentions_animation_asset_root,
      loader_fetches_session_animation_snapshot:
        seamSnapshot.frontend_source_surface.loader_fetches_session_animation_snapshot,
      loader_live_url_reuses_animation_route:
        seamSnapshot.frontend_source_surface.loader_live_url_reuses_animation_route
    },
    humanoid_channel_playback_surface: {
      avatar_runtime_wires_humanoid_channel_playback:
        seamSnapshot.frontend_source_surface.avatar_runtime_wires_humanoid_channel_playback,
      humanoid_playback_factory_present:
        seamSnapshot.frontend_source_surface.humanoid_playback_factory_present,
      humanoid_playback_requires_unity_humanoid_channel_space:
        seamSnapshot.frontend_source_surface.humanoid_playback_requires_unity_humanoid_channel_space,
      humanoid_playback_binds_representative_channels:
        seamSnapshot.frontend_source_surface.humanoid_playback_binds_representative_channels,
      idle_runtime_channel_space_matches_humanoid_playback:
        seamSnapshot.generated_runtime_payload_surface.idle_default.exported_channel_summary.channel_space ===
        "unity_humanoid_muscle",
      speak_runtime_channel_space_matches_humanoid_playback:
        seamSnapshot.generated_runtime_payload_surface.speak_loop.exported_channel_summary.channel_space ===
        "unity_humanoid_muscle"
    },
    generated_runtime_channel_proof: {
      idle_runtime_document_semantic_id: generatedIdleRuntimeDocument.semantic_id ?? null,
      idle_runtime_document_matches_idle_default: generatedIdleRuntimeDocument.semantic_id === baseAnimation.id,
      idle_runtime_document_exports_channels:
        seamSnapshot.generated_runtime_payload_surface.idle_default.exported_channel_summary.channel_count > 0,
      idle_runtime_document_has_representative_channel_coverage: exportedChannelSummaryHasRepresentativeCoverage(
        seamSnapshot.generated_runtime_payload_surface.idle_default.exported_channel_summary
      ),
      idle_runtime_document_channel_samples_match_playback: exportedChannelSummaryMatchesPlaybackSamples(
        seamSnapshot.generated_runtime_payload_surface.idle_default.exported_channel_summary
      ),
      idle_runtime_document_channel_values_vary: exportedChannelSummaryShowsVariation(
        seamSnapshot.generated_runtime_payload_surface.idle_default.exported_channel_summary
      ),
      generated_idle_payload_resolves: generatedIdlePayload !== null,
      generated_idle_payload_matches_backend_semantic_id: generatedIdlePayload?.semanticId === backendDefaultIdleCommand.semantic_id,
      generated_idle_payload_matches_backend_duration:
        backendExpectedDurationMs === null ? generatedIdlePayload !== null : generatedIdlePayload?.durationMs === backendExpectedDurationMs,
      speak_runtime_document_semantic_id: generatedSpeakRuntimeDocument.semantic_id ?? null,
      speak_runtime_document_exports_channels:
        seamSnapshot.generated_runtime_payload_surface.speak_loop.exported_channel_summary.channel_count > 0,
      speak_runtime_document_has_representative_channel_coverage: exportedChannelSummaryHasRepresentativeCoverage(
        seamSnapshot.generated_runtime_payload_surface.speak_loop.exported_channel_summary
      ),
      speak_runtime_document_channel_samples_match_playback: exportedChannelSummaryMatchesPlaybackSamples(
        seamSnapshot.generated_runtime_payload_surface.speak_loop.exported_channel_summary
      ),
      speak_runtime_document_channel_values_vary: exportedChannelSummaryShowsVariation(
        seamSnapshot.generated_runtime_payload_surface.speak_loop.exported_channel_summary
      ),
      generated_speak_payload_resolves: generatedSpeakPayload !== null,
      generated_speak_payload_matches_live_semantic_id:
        generatedSpeakPayload?.semanticId === updatedBackendSnapshot.command.semantic_id,
      generated_speak_payload_matches_live_playback:
        generatedSpeakPayload?.playback === updatedRuntimeCommand.playback,
      generated_speak_payload_matches_live_duration:
        updatedBackendSnapshot.command.playback.expected_duration_ms === null ||
        updatedBackendSnapshot.command.playback.expected_duration_ms === undefined
          ? generatedSpeakPayload !== null
          : generatedSpeakPayload?.durationMs === updatedBackendSnapshot.command.playback.expected_duration_ms,
      generated_speak_payload_avoids_idle_alias:
        generatedSpeakPayload?.semanticId === "speak.loop" && generatedSpeakPayload?.semanticId !== baseAnimation.id,
      generated_speak_motion_profile_differs_from_idle:
        generatedSpeakPayload?.semanticId === "speak.loop" &&
        !areMotionProfilesEqual(generatedSpeakMotionProfile, idleRuntimeMotionProfile)
    }
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main();