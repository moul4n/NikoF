import React, { useEffect, useState } from "react";
import { AvatarStage } from "../avatar/components/AvatarStage";
import { CharacterCatalogPanel } from "../avatar/components/CharacterCatalogPanel";
import {
  ActiveCharacterSyncError,
  bridgeCharacterCatalogWithBackend,
  loadCharacterCatalog,
  syncActiveCharacterSelection
} from "../avatar/loaders/characterCatalog";
import {
  createRejectedActiveCharacterSyncState,
  createSuccessfulActiveCharacterSyncState,
  resolveSelectedCharacterId
} from "../avatar/loaders/backendCharacterFlow";
import {
  startSpeechLifecycleLiveConsumption,
  type ConsumedSpeechLifecycleSnapshot,
  type SpeechLifecycleDeliveryMode
} from "../avatar/loaders/speechLifecycle";
import { createAvatarRuntime, type AvatarRuntimeBridge } from "../avatar/runtime/avatarRuntime";
import type {
  BackendSpeechSynthesisDocument,
  BackendSpeechTranscriptionDocument,
  CharacterCatalog,
  CharacterCatalogEntry,
  CharacterId
} from "../shared/types/character";

type CatalogLoadState =
  | {
      status: "loading";
      catalog: null;
      error: null;
    }
  | {
      status: "ready";
      catalog: CharacterCatalog;
      error: null;
    }
  | {
      status: "error";
      catalog: null;
      error: string;
    };

type BackendSyncState = {
  summariesConnected: boolean;
  activeCharacterConnected: boolean;
  sessionId: string | null;
  message: string | null;
};

type SpeechLifecycleLoadState = {
  status: "loading" | "ready" | "offline";
  snapshot: ConsumedSpeechLifecycleSnapshot | null;
  deliveryMode: SpeechLifecycleDeliveryMode;
  message: string | null;
};

type SurfaceMode = "control" | "display";

function findCharacterEntry(catalog: CharacterCatalog | null, characterId: CharacterId | null): CharacterCatalogEntry | null {
  if (!catalog || !characterId) {
    return null;
  }

  return catalog.entries.find((entry) => entry.summary.characterId === characterId) ?? null;
}

function describeBackendSyncState(syncState: BackendSyncState): string {
  if (syncState.message) {
    return syncState.message;
  }

  if (syncState.summariesConnected && syncState.activeCharacterConnected) {
    return "Backend bridge connected: shell is overlaying backend summaries and active-character state onto the local manifest catalog.";
  }

  if (syncState.summariesConnected) {
    return "Backend summaries connected; active-character selection is still local in this session.";
  }

  return "Backend bridge offline; shell is using the local manifest catalog only.";
}

function formatDurationLabel(durationMs: number | null | undefined): string {
  if (typeof durationMs !== "number") {
    return "timing unavailable";
  }

  return `${(durationMs / 1000).toFixed(2)}s`;
}

function describeSpeechLifecycleStateMessage(state: SpeechLifecycleLoadState): string | null {
  if (state.status !== "ready") {
    return state.message;
  }

  if (state.deliveryMode === "live") {
    return "Live SSE is connected on the backend-owned speech.lifecycle envelope.";
  }

  return state.message ?? "The shell is reading the backend-owned snapshot envelope while live delivery is unavailable.";
}

function resolveSurfaceModeFromLocation(): SurfaceMode {
  if (typeof window === "undefined") {
    return "control";
  }

  const surface = new URL(window.location.href).searchParams.get("surface");

  return surface === "display" ? "display" : "control";
}

function buildSurfaceHref(surfaceMode: SurfaceMode): string {
  if (typeof window === "undefined") {
    return surfaceMode === "display" ? "?surface=display" : ".";
  }

  const url = new URL(window.location.href);

  if (surfaceMode === "display") {
    url.searchParams.set("surface", "display");
  } else {
    url.searchParams.delete("surface");
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function syncSurfaceModeToLocation(surfaceMode: SurfaceMode): void {
  if (typeof window === "undefined") {
    return;
  }

  const nextHref = buildSurfaceHref(surfaceMode);
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (currentHref !== nextHref) {
    window.history.replaceState(null, "", nextHref);
  }
}

interface SurfaceModeSwitchProps {
  surfaceMode: SurfaceMode;
  onSelectSurfaceMode: (surfaceMode: SurfaceMode) => void;
  controlSurfaceHref: string;
  displaySurfaceHref: string;
}

function SurfaceModeSwitch({
  surfaceMode,
  onSelectSurfaceMode,
  controlSurfaceHref,
  displaySurfaceHref
}: SurfaceModeSwitchProps): JSX.Element {
  const alternateSurfaceHref = surfaceMode === "control" ? displaySurfaceHref : controlSurfaceHref;
  const alternateSurfaceLabel = surfaceMode === "control" ? "Open display window" : "Open control window";

  return (
    <nav className="surface-switcher" aria-label="Surface mode">
      <button
        type="button"
        className={surfaceMode === "control" ? "surface-switcher__button surface-switcher__button--active" : "surface-switcher__button"}
        aria-pressed={surfaceMode === "control"}
        onClick={() => onSelectSurfaceMode("control")}
      >
        Control surface
      </button>
      <button
        type="button"
        className={surfaceMode === "display" ? "surface-switcher__button surface-switcher__button--active" : "surface-switcher__button"}
        aria-pressed={surfaceMode === "display"}
        onClick={() => onSelectSurfaceMode("display")}
      >
        Display surface
      </button>
      <a className="surface-switcher__link" href={alternateSurfaceHref} target="_blank" rel="noreferrer">
        {alternateSurfaceLabel}
      </a>
    </nav>
  );
}

interface SpeechLifecyclePanelProps {
  state: SpeechLifecycleLoadState;
  snapshot: ConsumedSpeechLifecycleSnapshot | null;
  message: string | null;
  characterId: string;
  canonicalTranscription: BackendSpeechTranscriptionDocument | null;
  canonicalSynthesis: BackendSpeechSynthesisDocument | null;
}

function SpeechLifecyclePanel({
  state,
  snapshot,
  message,
  characterId,
  canonicalTranscription,
  canonicalSynthesis
}: SpeechLifecyclePanelProps): JSX.Element {
  return (
    <section className="speech-panel" aria-labelledby="speech-panel-title">
      <div className="speech-panel__header">
        <div>
          <p className="eyebrow">Speech lifecycle</p>
          <h2 id="speech-panel-title">Backend read surface</h2>
        </div>
        {snapshot ? <span className="speech-panel__count">{snapshot.eventCount} events</span> : null}
      </div>

      {state.status === "loading" ? <p className="speech-panel__message">Loading canonical speech lifecycle snapshot...</p> : null}
      {state.status === "offline" ? <p className="speech-panel__message speech-panel__message--error">{state.message}</p> : null}

      {snapshot ? (
        <>
          {message ? <p className="speech-panel__message">{message}</p> : null}

          <dl className="speech-panel__summary-list">
            <div>
              <dt>Session</dt>
              <dd>{snapshot.sessionId}</dd>
            </div>
            <div>
              <dt>Next cursor</dt>
              <dd>{snapshot.nextCursor}</dd>
            </div>
            <div>
              <dt>Event order</dt>
              <dd>{snapshot.orderedEnvelopePreserved ? "preserved" : "unexpected"}</dd>
            </div>
            <div>
              <dt>Character</dt>
              <dd>{characterId}</dd>
            </div>
          </dl>

          <div className="speech-panel__event-grid">
            <article className="speech-panel__event">
              <h3>Transcription</h3>
              <p className="speech-panel__event-status">
                {canonicalTranscription?.status ?? snapshot.canonicalTranscriptionEvent?.status ?? "unavailable"}
              </p>
              <p className="speech-panel__event-text">
                {canonicalTranscription?.transcript ?? "No canonical transcription event is present in the current snapshot."}
              </p>
              <p className="speech-panel__event-meta">
                {canonicalTranscription?.profile_id ?? "profile unavailable"} · {canonicalTranscription?.locale ?? "locale unavailable"}
                {" · "}
                {formatDurationLabel(canonicalTranscription?.timing?.utterance_duration_ms)}
              </p>
            </article>

            <article className="speech-panel__event">
              <h3>Synthesis</h3>
              <p className="speech-panel__event-status">
                {canonicalSynthesis?.status ?? snapshot.canonicalSpeechSynthesisEvent?.status ?? "unavailable"}
              </p>
              <p className="speech-panel__event-text">
                {canonicalSynthesis?.text ?? "No canonical synthesis event is present in the current snapshot."}
              </p>
              <p className="speech-panel__event-meta">
                {canonicalSynthesis?.profile_id ?? "profile unavailable"} · {canonicalSynthesis?.locale ?? "locale unavailable"}
                {" · "}
                {formatDurationLabel(canonicalSynthesis?.timing?.utterance_duration_ms)}
              </p>
            </article>
          </div>
        </>
      ) : null}
    </section>
  );
}

interface ControlSurfaceSummaryPanelProps {
  selectedCharacter: CharacterCatalogEntry | null;
  backendStatusMessage: string;
  backendSyncState: BackendSyncState;
  speechLifecycleState: SpeechLifecycleLoadState;
  speechLifecycleSnapshot: ConsumedSpeechLifecycleSnapshot | null;
}

function ControlSurfaceSummaryPanel({
  selectedCharacter,
  backendStatusMessage,
  backendSyncState,
  speechLifecycleState,
  speechLifecycleSnapshot
}: ControlSurfaceSummaryPanelProps): JSX.Element {
  const speechDeliveryLabel =
    speechLifecycleState.status === "offline"
      ? "offline"
      : speechLifecycleState.status === "loading"
        ? "loading"
        : speechLifecycleState.deliveryMode === "live"
          ? "live SSE"
          : "snapshot fallback";

  return (
    <section className="surface-panel" aria-labelledby="control-surface-summary-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Control surface</p>
          <h2 id="control-surface-summary-title">Configuration and session status</h2>
        </div>
      </div>

      <p className="surface-panel__message">{backendStatusMessage}</p>

      <dl className="surface-panel__facts">
        <div>
          <dt>Current surface</dt>
          <dd>Control shell</dd>
        </div>
        <div>
          <dt>Selected character</dt>
          <dd>{selectedCharacter?.summary.displayName ?? "No manifest-backed character selected"}</dd>
        </div>
        <div>
          <dt>Backend session</dt>
          <dd>{backendSyncState.sessionId ?? "No backend session id available"}</dd>
        </div>
        <div>
          <dt>Speech delivery</dt>
          <dd>{speechDeliveryLabel}</dd>
        </div>
      </dl>

      <p className="surface-panel__summary">
        The control surface keeps catalog selection, backend-confirmed active-character state, and speech lifecycle status in one shell while the display surface stays presentation-only.
      </p>
      {speechLifecycleSnapshot ? (
        <p className="surface-panel__summary">
          Current speech lifecycle cursor: {speechLifecycleSnapshot.nextCursor}.
        </p>
      ) : null}
    </section>
  );
}

interface DisplaySurfaceStatusPanelProps {
  selectedCharacter: CharacterCatalogEntry | null;
  backendStatusMessage: string;
  speechLifecycleState: SpeechLifecycleLoadState;
  speechLifecycleSnapshot: ConsumedSpeechLifecycleSnapshot | null;
  speechLifecycleMessage: string | null;
}

function DisplaySurfaceStatusPanel({
  selectedCharacter,
  backendStatusMessage,
  speechLifecycleState,
  speechLifecycleSnapshot,
  speechLifecycleMessage
}: DisplaySurfaceStatusPanelProps): JSX.Element {
  const speechDeliveryLabel =
    speechLifecycleState.status === "offline"
      ? "offline"
      : speechLifecycleState.status === "loading"
        ? "loading"
        : speechLifecycleState.deliveryMode === "live"
          ? "live SSE"
          : "snapshot fallback";

  return (
    <section className="surface-panel" aria-labelledby="display-surface-status-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Display surface</p>
          <h2 id="display-surface-status-title">Render-window status</h2>
        </div>
      </div>

      <dl className="surface-panel__facts">
        <div>
          <dt>Character</dt>
          <dd>{selectedCharacter?.summary.displayName ?? "Waiting for a manifest-backed selection"}</dd>
        </div>
        <div>
          <dt>Speech delivery</dt>
          <dd>{speechDeliveryLabel}</dd>
        </div>
        <div>
          <dt>Backend session</dt>
          <dd>{speechLifecycleSnapshot?.sessionId ?? "Session unavailable"}</dd>
        </div>
        <div>
          <dt>Event count</dt>
          <dd>{speechLifecycleSnapshot ? speechLifecycleSnapshot.eventCount : 0}</dd>
        </div>
      </dl>

      <p className="surface-panel__message">{backendStatusMessage}</p>
      {speechLifecycleMessage ? <p className="surface-panel__summary">{speechLifecycleMessage}</p> : null}
    </section>
  );
}

export function App(): JSX.Element {
  const [runtime] = useState<AvatarRuntimeBridge>(() => createAvatarRuntime());
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>(() => resolveSurfaceModeFromLocation());
  const [loadState, setLoadState] = useState<CatalogLoadState>({
    status: "loading",
    catalog: null,
    error: null
  });
  const [backendSyncState, setBackendSyncState] = useState<BackendSyncState>({
    summariesConnected: false,
    activeCharacterConnected: false,
    sessionId: null,
    message: null
  });
  const [speechLifecycleState, setSpeechLifecycleState] = useState<SpeechLifecycleLoadState>({
    status: "loading",
    snapshot: null,
    deliveryMode: "snapshot",
    message: null
  });
  const [speechLifecycleRefreshKey, setSpeechLifecycleRefreshKey] = useState(0);
  const [selectedCharacterId, setSelectedCharacterId] = useState<CharacterId | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handlePopState = (): void => {
      setSurfaceMode(resolveSurfaceModeFromLocation());
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    syncSurfaceModeToLocation(surfaceMode);
  }, [surfaceMode]);

  useEffect(() => {
    let cancelled = false;

    void loadCharacterCatalog()
      .then((catalog) => bridgeCharacterCatalogWithBackend(catalog))
      .then((bridge) => {
        if (cancelled) {
          return;
        }

        const nextMessages = [...bridge.messages];
        const nextSelectedCharacterId = resolveSelectedCharacterId(bridge.catalog, bridge.activeCharacterId);

        if (bridge.activeCharacterId && !findCharacterEntry(bridge.catalog, bridge.activeCharacterId)) {
          nextMessages.push(
            `Backend selected ${bridge.activeCharacterId}, but this shell only mounts characters with a local manifest package in the repo.`
          );
        }

        setLoadState({
          status: "ready",
          catalog: bridge.catalog,
          error: null
        });
        setSelectedCharacterId(nextSelectedCharacterId);
        setBackendSyncState({
          summariesConnected: bridge.summariesConnected,
          activeCharacterConnected: bridge.activeCharacterConnected,
          sessionId: bridge.sessionId,
          message: nextMessages[0] ?? null
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setLoadState({
          status: "error",
          catalog: null,
          error: error instanceof Error ? error.message : "Character catalog failed to load."
        });
      });

    return () => {
      cancelled = true;
      runtime.unmount();
    };
  }, [runtime]);

  useEffect(() => {
    const activeCharacter = findCharacterEntry(loadState.catalog, selectedCharacterId);

    if (!activeCharacter) {
      return;
    }

    void runtime.loadCharacter(activeCharacter.summary);
    runtime.setState("idle");
  }, [loadState.catalog, runtime, selectedCharacterId]);

  useEffect(() => {
    if (loadState.status === "error") {
      setSpeechLifecycleState({
        status: "offline",
        snapshot: null,
        deliveryMode: "snapshot",
        message: "Speech lifecycle read surface unavailable until the local manifest catalog loads successfully."
      });
      return;
    }

    if (loadState.status !== "ready") {
      return;
    }

    let cancelled = false;
    let liveConsumption: { close(): void } | null = null;

    if (speechLifecycleRefreshKey === 0) {
      setSpeechLifecycleState({
        status: "loading",
        snapshot: null,
        deliveryMode: "snapshot",
        message: null
      });
    }

    void startSpeechLifecycleLiveConsumption({
      onSnapshot: (snapshot, deliveryMode) => {
        if (cancelled) {
          return;
        }

        setSpeechLifecycleState((currentState) => ({
          status: "ready",
          snapshot,
          deliveryMode,
          message: deliveryMode === "live" ? null : currentState.message
        }));
      },
      onDeliveryModeChange: (deliveryMode, error) => {
        if (cancelled) {
          return;
        }

        setSpeechLifecycleState((currentState) => {
          if (currentState.status === "offline") {
            return currentState;
          }

          return {
            status: currentState.snapshot ? "ready" : currentState.status,
            snapshot: currentState.snapshot,
            deliveryMode,
            message:
              deliveryMode === "live"
                ? null
                : error
                  ? `${error.message} The shell is continuing from the latest backend snapshot.`
                  : currentState.message
          };
        });
      }
    })
      .then((subscription) => {
        if (cancelled) {
          subscription.close();
          return;
        }

        liveConsumption = subscription;
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setSpeechLifecycleState({
          status: "offline",
          snapshot: null,
          deliveryMode: "snapshot",
          message:
            error instanceof Error
              ? `${error.message} The shell stays on backend-confirmed character state without live speech delivery in this slice.`
              : "Backend speech lifecycle snapshot unavailable."
        });
      });

    return () => {
      cancelled = true;
      liveConsumption?.close();
    };
  }, [loadState.status, speechLifecycleRefreshKey]);

  function handleSelectCharacter(characterId: CharacterId): void {
    if (characterId === selectedCharacterId) {
      return;
    }

    setSelectedCharacterId(characterId);

    if (!backendSyncState.activeCharacterConnected) {
      return;
    }

    setBackendSyncState((currentState) => ({
      ...currentState,
      message: `Syncing ${characterId} to the backend active-character session...`
    }));

    void syncActiveCharacterSelection(characterId)
      .then((response) => {
        const nextSyncState = createSuccessfulActiveCharacterSyncState(loadState.catalog, response);

        setSelectedCharacterId(nextSyncState.selectedCharacterId);
        setSpeechLifecycleRefreshKey((currentKey) => currentKey + 1);
        setBackendSyncState((currentState) => ({
          ...currentState,
          ...nextSyncState
        }));
      })
      .catch((error: unknown) => {
        if (error instanceof ActiveCharacterSyncError) {
          const nextSyncState = createRejectedActiveCharacterSyncState(loadState.catalog, error.response);

          setSelectedCharacterId(nextSyncState.selectedCharacterId);
          setSpeechLifecycleRefreshKey((currentKey) => currentKey + 1);
          setBackendSyncState((currentState) => ({
            ...currentState,
            ...nextSyncState
          }));
          return;
        }

        setBackendSyncState((currentState) => ({
          ...currentState,
          message: error instanceof Error ? error.message : "Backend active-character sync failed; shell remains local."
        }));
      });
  }

  const selectedCharacter = findCharacterEntry(loadState.catalog, selectedCharacterId);
  const backendStatusMessage = describeBackendSyncState(backendSyncState);
  const speechLifecycleSnapshot = speechLifecycleState.snapshot;
  const speechLifecycleMessage = describeSpeechLifecycleStateMessage(speechLifecycleState);
  const canonicalTranscription = speechLifecycleSnapshot?.canonicalTranscriptionEvent?.transcription ?? null;
  const canonicalSynthesis = speechLifecycleSnapshot?.canonicalSpeechSynthesisEvent?.synthesis ?? null;
  const speechLifecycleCharacterId =
    speechLifecycleSnapshot?.canonicalSpeechSynthesisEvent?.character_id ??
    speechLifecycleSnapshot?.canonicalTranscriptionEvent?.character_id ??
    selectedCharacter?.summary.characterId ??
    "Unknown";
  const controlSurfaceHref = buildSurfaceHref("control");
  const displaySurfaceHref = buildSurfaceHref("display");

  if (surfaceMode === "display") {
    return (
      <div className="app-shell app-shell--display">
        <header className="app-shell__header app-shell__header--display">
          <div>
            <p className="eyebrow">Phase 0 scaffold</p>
            <h1>NikoF avatar display surface</h1>
          </div>
          <p className="app-shell__summary">
            This surface is the dedicated avatar render window. App still owns catalog load, active-character sync, and speech lifecycle consumption; the display view only presents the current state.
          </p>
          <SurfaceModeSwitch
            surfaceMode={surfaceMode}
            onSelectSurfaceMode={setSurfaceMode}
            controlSurfaceHref={controlSurfaceHref}
            displaySurfaceHref={displaySurfaceHref}
          />
        </header>

        <main className="app-shell__display">
          <AvatarStage runtime={runtime} selectedCharacter={selectedCharacter} variant="display" />
          <DisplaySurfaceStatusPanel
            selectedCharacter={selectedCharacter}
            backendStatusMessage={backendStatusMessage}
            speechLifecycleState={speechLifecycleState}
            speechLifecycleSnapshot={speechLifecycleSnapshot}
            speechLifecycleMessage={speechLifecycleMessage}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div>
          <p className="eyebrow">Phase 0 scaffold</p>
          <h1>NikoF control surface</h1>
        </div>
        <p className="app-shell__summary">
          The control surface keeps manifest-backed catalog selection, backend-confirmed session status, and speech lifecycle telemetry in one shell. The avatar render window now lives on the separate display surface.
        </p>
        <SurfaceModeSwitch
          surfaceMode={surfaceMode}
          onSelectSurfaceMode={setSurfaceMode}
          controlSurfaceHref={controlSurfaceHref}
          displaySurfaceHref={displaySurfaceHref}
        />
      </header>

      <main className="app-shell__content app-shell__content--control">
        <div className="app-shell__sidebar">
          <CharacterCatalogPanel
            catalog={loadState.catalog}
            error={loadState.error}
            isLoading={loadState.status === "loading"}
            statusMessage={loadState.status === "ready" ? backendStatusMessage : null}
            selectedCharacterId={selectedCharacterId}
            onSelectCharacter={handleSelectCharacter}
          />
          <SpeechLifecyclePanel
            state={speechLifecycleState}
            snapshot={speechLifecycleSnapshot}
            message={speechLifecycleMessage}
            characterId={speechLifecycleCharacterId}
            canonicalTranscription={canonicalTranscription}
            canonicalSynthesis={canonicalSynthesis}
          />
        </div>
        <div className="app-shell__control-rail">
          <ControlSurfaceSummaryPanel
            selectedCharacter={selectedCharacter}
            backendStatusMessage={backendStatusMessage}
            backendSyncState={backendSyncState}
            speechLifecycleState={speechLifecycleState}
            speechLifecycleSnapshot={speechLifecycleSnapshot}
          />
        </div>
      </main>
    </div>
  );
}