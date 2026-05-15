import { readFile } from "fs/promises";
import { resolveBaseAnimationMotionProfile } from "../../frontend/src/avatar/runtime/baseAnimationMotionProfile.js";
import { resolveSharedSemanticAnimationPayload } from "../../frontend/src/avatar/runtime/defaultBaseAnimation.js";
import type { SemanticAnimationCommand, SemanticAnimationMotionProfile } from "../../frontend/src/shared/types/animation.js";

type BackendSessionAnimationCommandSnapshot = {
  lifecycle_state: string;
  character_id: string;
  semantic_id: string;
  selected_source: string;
  playback_mode: string;
  expected_duration_ms?: number | null;
};

type FrontendSemanticLoopAssetSnapshot = {
  session_animation_commands: BackendSessionAnimationCommandSnapshot[];
};

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

function resolveFrontendPlaybackMode(mode: string): "loop" | "once" {
  return mode === "loop" ? "loop" : "once";
}

function buildRuntimeCommand(
  commandSnapshot: BackendSessionAnimationCommandSnapshot
): SemanticAnimationCommand {
  return {
    id: commandSnapshot.semantic_id,
    source: "shared",
    playback: resolveFrontendPlaybackMode(commandSnapshot.playback_mode),
    durationMs: commandSnapshot.expected_duration_ms ?? undefined
  };
}

async function main(): Promise<void> {
  const snapshotPath = process.argv[2];

  if (!snapshotPath) {
    throw new Error("Expected a frontend semantic loop asset snapshot path argument.");
  }

  const seamSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as FrontendSemanticLoopAssetSnapshot;
  const runtimeProof = seamSnapshot.session_animation_commands.map((commandSnapshot) => {
    const runtimeCommand = buildRuntimeCommand(commandSnapshot);
    const runtimePayload = resolveSharedSemanticAnimationPayload(runtimeCommand);
    const runtimeMotionProfile = runtimePayload ? resolveBaseAnimationMotionProfile(runtimePayload) : null;

    return {
      lifecycle_state: commandSnapshot.lifecycle_state,
      backend_command: commandSnapshot,
      runtime_command: runtimeCommand,
      runtime_payload: runtimePayload,
      runtime_motion_profile: runtimeMotionProfile,
      runtime_payload_resolves: runtimePayload !== null,
      runtime_payload_matches_backend_semantic_id: runtimePayload?.semanticId === commandSnapshot.semantic_id,
      runtime_payload_matches_backend_playback: runtimePayload?.playback === runtimeCommand.playback,
      runtime_payload_matches_backend_duration:
        commandSnapshot.expected_duration_ms === null || commandSnapshot.expected_duration_ms === undefined
          ? runtimePayload !== null
          : runtimePayload?.durationMs === commandSnapshot.expected_duration_ms,
      backend_command_uses_shared_source: commandSnapshot.selected_source === "shared_library"
    };
  });
  const idlePayload = runtimeProof.find((proof) => proof.lifecycle_state === "idle")?.runtime_payload ?? null;
  const listenPayload = runtimeProof.find((proof) => proof.lifecycle_state === "listen")?.runtime_payload ?? null;
  const speakPayload = runtimeProof.find((proof) => proof.lifecycle_state === "speak")?.runtime_payload ?? null;
  const idleMotionProfile = runtimeProof.find((proof) => proof.lifecycle_state === "idle")?.runtime_motion_profile ?? null;
  const listenMotionProfile = runtimeProof.find((proof) => proof.lifecycle_state === "listen")?.runtime_motion_profile ?? null;
  const speakMotionProfile = runtimeProof.find((proof) => proof.lifecycle_state === "speak")?.runtime_motion_profile ?? null;

  process.stdout.write(
    `${JSON.stringify(
      {
        runtime_proof: runtimeProof,
        alignment: {
          all_backend_commands_use_shared_source: runtimeProof.every((proof) => proof.backend_command_uses_shared_source),
          all_runtime_payloads_resolve: runtimeProof.every((proof) => proof.runtime_payload_resolves),
          all_runtime_payloads_match_backend_semantic_id: runtimeProof.every(
            (proof) => proof.runtime_payload_matches_backend_semantic_id
          ),
          all_runtime_payloads_match_backend_playback: runtimeProof.every(
            (proof) => proof.runtime_payload_matches_backend_playback
          ),
          all_runtime_payloads_match_backend_duration: runtimeProof.every(
            (proof) => proof.runtime_payload_matches_backend_duration
          ),
          listen_payload_avoids_idle_alias:
            listenPayload?.semanticId === "listen.loop" && listenPayload?.semanticId !== idlePayload?.semanticId,
          speak_payload_avoids_idle_alias:
            speakPayload?.semanticId === "speak.loop" && speakPayload?.semanticId !== idlePayload?.semanticId,
          listen_motion_profile_differs_from_idle:
            listenPayload?.semanticId === "listen.loop" && !areMotionProfilesEqual(listenMotionProfile, idleMotionProfile),
          speak_motion_profile_differs_from_idle:
            speakPayload?.semanticId === "speak.loop" && !areMotionProfilesEqual(speakMotionProfile, idleMotionProfile),
          dedicated_semantic_loop_payloads_preserved:
            idlePayload?.semanticId === "idle.default" &&
            listenPayload?.semanticId === "listen.loop" &&
            speakPayload?.semanticId === "speak.loop"
        }
      },
      null,
      2
    )}\n`
  );
}

void main();