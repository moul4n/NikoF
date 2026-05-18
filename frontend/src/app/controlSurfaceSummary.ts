import type {
  BackendHealthPayloadDocument,
  BackendRuntimePrerequisiteLaneDocument,
  BackendRuntimePrerequisiteState
} from "../shared/types/character";

export type RuntimeLaneId = "llm" | "stt" | "tts";

export type RuntimeLaneSummary = {
  id: RuntimeLaneId;
  label: string;
  state: BackendRuntimePrerequisiteState;
  blockerDetail: string | null;
  statusLabel: string;
};

function resolveRuntimeLaneId(lane: BackendRuntimePrerequisiteLaneDocument): RuntimeLaneId | null {
  const id = lane.id.toLowerCase();
  const displayName = lane.display_name.toLowerCase();

  if (id === "llm" || displayName.includes("llm") || displayName.includes("ollama")) {
    return "llm";
  }

  if (id === "stt" || displayName.includes("stt") || displayName.includes("whisper")) {
    return "stt";
  }

  if (id === "tts" || displayName.includes("tts") || displayName.includes("sovits")) {
    return "tts";
  }

  return null;
}

function resolveRuntimeLaneState(lane: BackendRuntimePrerequisiteLaneDocument): BackendRuntimePrerequisiteState {
  return lane.state;
}

function resolveRuntimeLaneBlockerDetail(lane: BackendRuntimePrerequisiteLaneDocument): string | null {
  const blockerSummaries = (lane.blockers ?? [])
    .map((blocker) => blocker.summary.trim())
    .filter((summary) => summary.length > 0);

  const uniqueBlockerSummaries = [...new Set(blockerSummaries)];

  if (uniqueBlockerSummaries.length === 0) {
    return null;
  }

  return uniqueBlockerSummaries.slice(0, 2).join(" ");
}

export function formatRuntimeLaneStatus(lane: Pick<RuntimeLaneSummary, "state" | "blockerDetail">): string {
  if (!lane.blockerDetail) {
    return lane.state;
  }

  return `${lane.state} - ${lane.blockerDetail}`;
}

export function formatRuntimeLaneVisibleSummary(lane: Pick<RuntimeLaneSummary, "label" | "statusLabel">): string {
  return `${lane.label}: ${lane.statusLabel}`;
}

export function resolveRuntimeLaneSummaries(healthPayload: BackendHealthPayloadDocument | null): RuntimeLaneSummary[] {
  const prerequisiteLanes = healthPayload?.diagnostics.prerequisite_lanes ?? [];

  if (prerequisiteLanes.length === 0) {
    return [];
  }

  const laneOrder: RuntimeLaneId[] = ["llm", "stt", "tts"];
  const laneLabels: Record<RuntimeLaneId, string> = {
    llm: "LLM lane",
    stt: "STT lane",
    tts: "TTS lane"
  };

  return laneOrder
    .map((laneId) => {
      const lane = prerequisiteLanes.find((candidateLane) => resolveRuntimeLaneId(candidateLane) === laneId);

      if (!lane) {
        return null;
      }

      const blockerDetail = resolveRuntimeLaneBlockerDetail(lane);

      return {
        id: laneId,
        label: laneLabels[laneId],
        state: resolveRuntimeLaneState(lane),
        blockerDetail,
        statusLabel: formatRuntimeLaneStatus({ state: resolveRuntimeLaneState(lane), blockerDetail })
      };
    })
    .filter((lane): lane is RuntimeLaneSummary => lane !== null);
}

export function resolveBackendHealthSummary(runtimeLaneSummaries: RuntimeLaneSummary[]): string | null {
  return runtimeLaneSummaries.length > 0 ? "Local prerequisite truth is coming from the backend health surface." : null;
}

export function resolveVisibleRuntimeLaneSummary(runtimeLaneSummaries: RuntimeLaneSummary[]): string | null {
  if (runtimeLaneSummaries.length === 0) {
    return null;
  }

  return `Prerequisite lanes: ${runtimeLaneSummaries.map((lane) => formatRuntimeLaneVisibleSummary(lane)).join(" | ")}`;
}