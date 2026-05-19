import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { VrmaPlaybackBridge } from "./vrmaPlayback";
import { resolveVrmaAssetCandidates } from "./vrmaAssetResolution";

export interface PlayAnimationCommand {
  command: "play_animation";
  clip_id: string;
  url?: string;
  transition_ms?: number;
  loop?: boolean;
}

export interface StopAnimationCommand {
  command: "stop_animation";
  clip_id: string;
  fade_out_ms?: number;
}

export interface CrossfadeCommand {
  command: "crossfade";
  from: string;
  to: string;
  to_url?: string;
  duration_ms: number;
}

export interface SetExpressionCommand {
  command: "set_expression";
  name: string;
  weight: number;
  transition_ms?: number;
}

export interface SetLookatCommand {
  command: "set_lookat";
  target: [number, number, number];
}

export type AnimationCommand =
  | PlayAnimationCommand
  | StopAnimationCommand
  | CrossfadeCommand
  | SetExpressionCommand
  | SetLookatCommand;

export interface AnimationCommandHandlerBridge {
  handleCommand(command: AnimationCommand): Promise<void>;
  update(deltaSeconds: number): void;
  dispose(): void;
}

export function createAnimationCommandHandler(
  vrm: VRM,
  vrmaPlayback: VrmaPlaybackBridge
): AnimationCommandHandlerBridge {
  let lookatTarget: THREE.Object3D | null = null;
  const expressionTransitions = new Map<string, {
    targetWeight: number;
    startWeight: number;
    elapsed: number;
    duration: number;
  }>();

  async function handleCommand(command: AnimationCommand): Promise<void> {
    switch (command.command) {
      case "play_animation":
        return handlePlayAnimation(command);
      case "stop_animation":
        return handleStopAnimation(command);
      case "crossfade":
        return handleCrossfade(command);
      case "set_expression":
        return handleSetExpression(command);
      case "set_lookat":
        return handleSetLookat(command);
    }
  }

  async function handlePlayAnimation(cmd: PlayAnimationCommand): Promise<void> {
    const url = cmd.url ?? resolveVrmaAssetCandidates(cmd.clip_id)[0]?.url;
    if (url) {
      await vrmaPlayback.loadVrma(url, cmd.clip_id);
    }
    vrmaPlayback.play(cmd.clip_id, {
      loop: cmd.loop ?? true,
      transitionMs: cmd.transition_ms ?? 0
    });
  }

  async function handleStopAnimation(cmd: StopAnimationCommand): Promise<void> {
    vrmaPlayback.stop(cmd.clip_id, { fadeOutMs: cmd.fade_out_ms ?? 0 });
  }

  async function handleCrossfade(cmd: CrossfadeCommand): Promise<void> {
    const toUrl = cmd.to_url ?? resolveVrmaAssetCandidates(cmd.to)[0]?.url;
    if (toUrl) {
      await vrmaPlayback.loadVrma(toUrl, cmd.to);
    }
    vrmaPlayback.crossfade(cmd.from, cmd.to, cmd.duration_ms);
  }

  async function handleSetExpression(cmd: SetExpressionCommand): Promise<void> {
    const transitionMs = cmd.transition_ms ?? 0;

    if (transitionMs <= 0) {
      vrm.expressionManager?.setValue(cmd.name, cmd.weight);
      expressionTransitions.delete(cmd.name);
      return;
    }

    const currentWeight = vrm.expressionManager?.getValue(cmd.name) ?? 0;
    expressionTransitions.set(cmd.name, {
      targetWeight: cmd.weight,
      startWeight: currentWeight,
      elapsed: 0,
      duration: transitionMs / 1000
    });
  }

  async function handleSetLookat(cmd: SetLookatCommand): Promise<void> {
    if (vrm.lookAt) {
      // three-vrm v3 lookAt.target is an Object3D; position it at the gaze point.
      if (!lookatTarget) {
        lookatTarget = new THREE.Object3D();
        vrm.scene.add(lookatTarget);
        vrm.lookAt.target = lookatTarget;
      }
      lookatTarget.position.set(cmd.target[0], cmd.target[1], cmd.target[2]);
    }
  }

  function update(deltaSeconds: number): void {
    // Advance expression transitions
    for (const [name, transition] of expressionTransitions) {
      transition.elapsed += deltaSeconds;
      const t = Math.min(transition.elapsed / transition.duration, 1);
      const weight = transition.startWeight + (transition.targetWeight - transition.startWeight) * t;
      vrm.expressionManager?.setValue(name, weight);

      if (t >= 1) {
        expressionTransitions.delete(name);
      }
    }
  }

  function dispose(): void {
    expressionTransitions.clear();
  }

  return {
    handleCommand,
    update,
    dispose
  };
}
