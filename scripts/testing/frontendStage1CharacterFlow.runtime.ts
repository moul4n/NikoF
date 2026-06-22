import { readFile } from "fs/promises";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  createBackendCharacterCatalogBridge,
  createRejectedActiveCharacterSyncState,
  createSuccessfulActiveCharacterSyncState
} from "../../frontend/src/avatar/loaders/backendCharacterFlow.js";
import {
  resolveBackendHealthSummary,
  resolveRuntimeLaneSummaries,
  resolveVisibleRuntimeLaneSummary
} from "../../frontend/src/app/controlSurfaceSummary.js";
import { ControlSurfaceShell } from "../../frontend/src/app/ControlSurfaceShell.js";
import type { SpeechPlaybackState } from "../../frontend/src/app/useSpeechPlaybackBridge.js";
import type { SpeechLifecycleLoadState } from "../../frontend/src/app/useSpeechLifecycleState.js";
import type {
  BackendActiveCharacterResponseDocument,
  BackendCharacterCatalogResponseDocument,
  BackendHealthPayloadDocument,
  CharacterCatalog,
  CharacterManifestSummary
} from "../../frontend/src/shared/types/character.js";

type BackendStage1ContractsSnapshot = {
  responses: {
    health: BackendHealthPayloadDocument;
    characters: BackendCharacterCatalogResponseDocument;
    get_active_character: BackendActiveCharacterResponseDocument;
    put_active_character: {
      request: {
        character_id: string;
        reason: string;
      };
      response: BackendActiveCharacterResponseDocument;
    };
    put_active_character_invalid: {
      request: {
        character_id: string;
        reason: string;
      };
      http_status: number;
      response: BackendActiveCharacterResponseDocument;
    };
  };
};

type RenderedSummaryPanel = {
  factRows: Array<{
    label: string;
    value: string;
  }>;
  summaryMessages: string[];
};

type GlobalSnapshot = {
  key: string;
  hadOwnProperty: boolean;
  value: unknown;
};

async function main(): Promise<void> {
  const snapshotPath = process.argv[2];
  const characterShellHookPath = process.argv[3];

  if (!snapshotPath) {
    throw new Error("Expected a backend Stage 1 snapshot path argument.");
  }

  if (!characterShellHookPath) {
    throw new Error("Expected a character shell hook source path argument.");
  }

  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as BackendStage1ContractsSnapshot;
  const characterShellHookSource = await readFile(characterShellHookPath, "utf8");
  const localCatalog = buildLocalCatalog(snapshot.responses.characters);
  const firstLocalDisplayName = localCatalog.entries[0]?.summary.displayName ?? null;
  const bridgedCatalog = createBackendCharacterCatalogBridge(
    localCatalog,
    snapshot.responses.characters,
    snapshot.responses.get_active_character,
    snapshot.responses.health
  );
  const successState = createSuccessfulActiveCharacterSyncState(localCatalog, snapshot.responses.put_active_character.response);
  const rejectionState = createRejectedActiveCharacterSyncState(
    localCatalog,
    snapshot.responses.put_active_character_invalid.response
  );
  const runtimeLaneSummaries = resolveRuntimeLaneSummaries(snapshot.responses.health);
  const backendHealthSummary = resolveBackendHealthSummary(runtimeLaneSummaries);
  const visiblePrerequisiteSummary = resolveVisibleRuntimeLaneSummary(runtimeLaneSummaries);
  const backendStatusMessage =
    bridgedCatalog.messages[0] ??
    "Backend bridge connected: shell is overlaying backend summaries and active-character state onto the local manifest catalog.";
  const speechLifecycleState: SpeechLifecycleLoadState = {
    status: "ready",
    snapshot: null,
    deliveryMode: "snapshot",
    message: null
  };
  const speechPlaybackStatus: SpeechPlaybackState = {
    status: "idle",
    transport: "none",
    playbackKey: null,
    message: "Idle playback bridge.",
    error: null,
    audioReference: null,
    audioSource: null,
    synthesisStatus: null,
    profileId: null,
    locale: null,
    utteranceDurationMs: null,
    text: null
  };
  const renderedControlShell = renderControlShellSummaryInDom(
    React.createElement(ControlSurfaceShell, {
      loadState: {
        status: "ready",
        catalog: bridgedCatalog.catalog,
        error: null
      },
      selectedCharacter: bridgedCatalog.catalog.entries[0] ?? null,
      selectedCharacterId: bridgedCatalog.catalog.entries[0]?.summary.characterId ?? null,
      onSelectCharacter: () => {},
      onCommandPublished: () => {},
      backendStatusMessage,
      backendSyncState: {
        summariesConnected: bridgedCatalog.summariesConnected,
        activeCharacterConnected: bridgedCatalog.activeCharacterConnected,
        healthPayload: snapshot.responses.health,
        sessionId: snapshot.responses.get_active_character.session_id,
        message: bridgedCatalog.messages[0] ?? null
      },
      speechLifecycleState,
      speechPlaybackStatus
    })
  );
  const renderedLaneRows = runtimeLaneSummaries.map((lane) => ({
    id: lane.id,
    row_text: `${lane.label}: ${lane.statusLabel}`,
    rendered: renderedControlShell.factRows.some((row) => row.label === lane.label && row.value === lane.statusLabel)
  }));
  const renderedBackendHealthSummaryText = backendHealthSummary
    ? renderedControlShell.summaryMessages.find((message) => message === backendHealthSummary) ?? null
    : null;
  const renderedVisiblePrerequisiteSummaryText = visiblePrerequisiteSummary
    ? renderedControlShell.summaryMessages.find((message) => message === visiblePrerequisiteSummary) ?? null
    : null;

  const result = {
    bridge_runtime: {
      summaries_connected: bridgedCatalog.summariesConnected,
      active_character_connected: bridgedCatalog.activeCharacterConnected,
      active_character_id: bridgedCatalog.activeCharacterId,
      first_display_name_before: firstLocalDisplayName,
      first_display_name_after: bridgedCatalog.catalog.entries[0]?.summary.displayName ?? null,
      catalog_envelope_consumed:
        bridgedCatalog.catalog.entries[0]?.summary.displayName === snapshot.responses.characters.characters[0]?.display_name,
      catalog_message_count: bridgedCatalog.messages.length
    },
    character_shell_hook_runtime: {
      exported_hook_present: characterShellHookSource.includes("export function useCharacterShellState"),
      backend_bridge_marker_present: characterShellHookSource.includes("bridgeCharacterCatalogWithBackend"),
      active_sync_error_marker_present: characterShellHookSource.includes("ActiveCharacterSyncError"),
      active_character_submit_marker_present: characterShellHookSource.includes("syncActiveCharacterSelection"),
      success_reconciliation_marker_present: characterShellHookSource.includes("createSuccessfulActiveCharacterSyncState"),
      rejection_reconciliation_marker_present: characterShellHookSource.includes("createRejectedActiveCharacterSyncState")
    },
    control_surface_summary_runtime: {
      prerequisite_lane_count: runtimeLaneSummaries.length,
      backend_health_summary: backendHealthSummary,
      control_shell_dom_mount: {
        mounted: true,
        summary_panel_found: renderedControlShell.summaryPanelFound,
        fact_row_count: renderedControlShell.factRows.length,
        summary_count: renderedControlShell.summaryMessages.length
      },
      renders_prerequisite_lane_rows: renderedLaneRows.every((lane) => lane.rendered),
      renders_backend_health_summary: renderedBackendHealthSummaryText !== null,
      renders_visible_prerequisite_summary: renderedVisiblePrerequisiteSummaryText !== null,
      rendered_backend_health_summary_text: renderedBackendHealthSummaryText,
      rendered_visible_prerequisite_summary_text: renderedVisiblePrerequisiteSummaryText,
      rendered_prerequisite_lane_rows: renderedLaneRows,
      visible_prerequisite_summary: visiblePrerequisiteSummary,
      prerequisite_lanes: runtimeLaneSummaries.map((lane) => ({
        id: lane.id,
        label: lane.label,
        state: lane.state,
        blocker_detail: lane.blockerDetail,
        status_label: lane.statusLabel
      }))
    },
    success_sync_runtime: {
      requested_character_id: snapshot.responses.put_active_character.request.character_id,
      backend_confirmed_character_id: snapshot.responses.put_active_character.response.active_character.character_id,
      selected_character_id: successState.selectedCharacterId,
      message: successState.message,
      session_id: successState.sessionId,
      matched_backend_confirmed_character:
        successState.selectedCharacterId === snapshot.responses.put_active_character.response.active_character.character_id
    },
    rejection_sync_runtime: {
      requested_character_id: snapshot.responses.put_active_character_invalid.request.character_id,
      backend_confirmed_character_id: snapshot.responses.put_active_character_invalid.response.active_character.character_id,
      selected_character_id: rejectionState.selectedCharacterId,
      message: rejectionState.message,
      session_id: rejectionState.sessionId,
      matched_backend_confirmed_character:
        rejectionState.selectedCharacterId === snapshot.responses.put_active_character_invalid.response.active_character.character_id
    }
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function renderControlShellSummaryInDom(element: JSX.Element): RenderedSummaryPanel & { summaryPanelFound: boolean } {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://127.0.0.1/control/"
  });
  const globalSnapshots = installDomGlobals(dom.window);
  const container = dom.window.document.getElementById("root");

  if (!container) {
    restoreDomGlobals(globalSnapshots);
    dom.window.close();
    throw new Error("Expected summary-panel DOM mount container.");
  }

  const root = createRoot(container);

  try {
    flushSync(() => {
      root.render(element);
    });

    const summaryPanel = dom.window.document.querySelector('[aria-labelledby="control-surface-summary-title"]');

    if (!summaryPanel) {
      throw new Error("Expected ControlSurfaceShell to render the prerequisite summary panel.");
    }

    return {
      summaryPanelFound: true,
      factRows: Array.from(summaryPanel.querySelectorAll(".surface-panel__facts > div"))
        .map((row) => {
          const factRow = row as Element;

          return {
            label: normalizeRenderedText(factRow.querySelector("dt")?.textContent),
            value: normalizeRenderedText(factRow.querySelector("dd")?.textContent)
          };
        })
        .filter((row) => row.label.length > 0),
      summaryMessages: Array.from(summaryPanel.querySelectorAll(".surface-panel__summary"))
        .map((summaryNode) => normalizeRenderedText((summaryNode as Element).textContent))
        .filter((summaryText) => summaryText.length > 0)
    };
  } finally {
    root.unmount();
    restoreDomGlobals(globalSnapshots);
    dom.window.close();
  }
}

function installDomGlobals(window: any): GlobalSnapshot[] {
  const assignments: Record<string, unknown> = {
    window,
    document: window.document,
    self: window,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    EventTarget: window.EventTarget,
    requestAnimationFrame: (callback: (timestamp: number) => void) => window.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => window.clearTimeout(handle)
  };

  return Object.entries(assignments).map(([key, value]) => {
    const globalObject = globalThis as Record<string, unknown>;
    const hadOwnProperty = Object.prototype.hasOwnProperty.call(globalObject, key);
    const snapshot = {
      key,
      hadOwnProperty,
      value: globalObject[key]
    };

    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });

    return snapshot;
  });
}

function restoreDomGlobals(globalSnapshots: GlobalSnapshot[]): void {
  for (const snapshot of globalSnapshots.reverse()) {
    if (snapshot.hadOwnProperty) {
      Object.defineProperty(globalThis, snapshot.key, {
        configurable: true,
        writable: true,
        value: snapshot.value
      });
      continue;
    }

    delete (globalThis as Record<string, unknown>)[snapshot.key];
  }
}

function normalizeRenderedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function buildLocalCatalog(catalogResponse: BackendCharacterCatalogResponseDocument): CharacterCatalog {
  return {
    entries: catalogResponse.characters.map((character, index) => ({
      manifestUrl: `/assets/characters/${character.character_id}/manifest.json`,
      summary: buildLocalManifestSummary(character, index)
    })),
    defaultCharacterId: catalogResponse.characters[0]?.character_id ?? null,
    loadedAt: "2026-05-14T00:00:00.000Z"
  };
}

function buildLocalManifestSummary(
  character: BackendCharacterCatalogResponseDocument["characters"][number],
  index: number
): CharacterManifestSummary {
  return {
    schemaVersion: 0,
    characterId: character.character_id,
    displayName: `Local Placeholder ${index + 1}`,
    identitySource: "local-placeholder",
    assetVersion: "test-snapshot",
    vrmSpecVersion: "0.0-local",
    supportedStates: ["idle"],
    sharedAnimationSet: `local-placeholder-${index + 1}`,
    assets: {
      baseUrl: `/assets/characters/${character.character_id}/`,
      manifestUrl: `/assets/characters/${character.character_id}/manifest.json`,
      modelUrl: `/assets/characters/${character.character_id}/model.vrm`,
      metadataUrl: `/assets/characters/${character.character_id}/metadata/identity.json`,
      expressionMapUrl: `/assets/characters/${character.character_id}/expressions/map.json`,
      voiceProfile: {
        profileId: `local-profile-${index + 1}`,
        url: `/assets/characters/${character.character_id}/voice/profile.json`
      }
    }
  };
}

void main();