import type { SemanticAnimationCommand } from "../../shared/types/animation";
import type { CharacterId, CharacterManifestSummary, CharacterRuntimeState } from "../../shared/types/character";
import type { AvatarRuntimeMountPoints } from "./mountPoints";

export interface AvatarRuntimeSnapshot {
  mounted: boolean;
  currentCharacterId: CharacterId | null;
  currentState: CharacterRuntimeState;
  mountPoints: AvatarRuntimeMountPoints | null;
  pendingAnimation: SemanticAnimationCommand | null;
}

export interface AvatarRuntimeBridge {
  mount: (mountPoints: AvatarRuntimeMountPoints) => void;
  unmount: () => void;
  loadCharacter: (character: CharacterManifestSummary) => void;
  setState: (state: CharacterRuntimeState) => void;
  play: (command: SemanticAnimationCommand) => void;
  snapshot: () => AvatarRuntimeSnapshot;
}

export function createAvatarRuntime(): AvatarRuntimeBridge {
  let snapshot: AvatarRuntimeSnapshot = {
    mounted: false,
    currentCharacterId: null,
    currentState: "idle",
    mountPoints: null,
    pendingAnimation: null
  };

  return {
    mount(mountPoints) {
      snapshot = {
        ...snapshot,
        mounted: true,
        mountPoints
      };
    },

    unmount() {
      snapshot = {
        ...snapshot,
        mounted: false,
        mountPoints: null,
        pendingAnimation: null
      };
    },

    loadCharacter(character) {
      snapshot = {
        ...snapshot,
        currentCharacterId: character.characterId
      };
    },

    setState(state) {
      snapshot = {
        ...snapshot,
        currentState: state
      };
    },

    play(command) {
      snapshot = {
        ...snapshot,
        pendingAnimation: command
      };
    },

    snapshot() {
      return {
        ...snapshot
      };
    }
  };
}