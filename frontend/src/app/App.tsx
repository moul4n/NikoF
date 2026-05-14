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
import type { CharacterCatalog, CharacterCatalogEntry, CharacterId } from "../shared/types/character";

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

export function App(): JSX.Element {
  const [runtime] = useState<AvatarRuntimeBridge>(() => createAvatarRuntime());
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

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div>
          <p className="eyebrow">Phase 0 scaffold</p>
          <h1>NikoF avatar shell</h1>
        </div>
        <p className="app-shell__summary">
          The catalog is seeded with manifest entry points only. All avatar asset URLs are resolved from the manifest that each
          character package publishes.
        </p>
        <p className="app-shell__summary">{backendStatusMessage}</p>
      </header>

      <main className="app-shell__content">
        <div className="app-shell__sidebar">
          <CharacterCatalogPanel
            catalog={loadState.catalog}
            error={loadState.error}
            isLoading={loadState.status === "loading"}
            statusMessage={loadState.status === "ready" ? backendStatusMessage : null}
            selectedCharacterId={selectedCharacterId}
            onSelectCharacter={handleSelectCharacter}
          />
          <section className="speech-panel" aria-labelledby="speech-panel-title">
            <div className="speech-panel__header">
              <div>
                <p className="eyebrow">Speech lifecycle</p>
                <h2 id="speech-panel-title">Backend read surface</h2>
              </div>
              {speechLifecycleSnapshot ? <span className="speech-panel__count">{speechLifecycleSnapshot.eventCount} events</span> : null}
            </div>

            {speechLifecycleState.status === "loading" ? (
              <p className="speech-panel__message">Loading canonical speech lifecycle snapshot...</p>
            ) : null}
            {speechLifecycleState.status === "offline" ? (
              <p className="speech-panel__message speech-panel__message--error">{speechLifecycleState.message}</p>
            ) : null}

            {speechLifecycleSnapshot ? (
              <>
                {speechLifecycleMessage ? <p className="speech-panel__message">{speechLifecycleMessage}</p> : null}

                <dl className="speech-panel__summary-list">
                  <div>
                    <dt>Session</dt>
                    <dd>{speechLifecycleSnapshot.sessionId}</dd>
                  </div>
                  <div>
                    <dt>Next cursor</dt>
                    <dd>{speechLifecycleSnapshot.nextCursor}</dd>
                  </div>
                  <div>
                    <dt>Event order</dt>
                    <dd>{speechLifecycleSnapshot.orderedEnvelopePreserved ? "preserved" : "unexpected"}</dd>
                  </div>
                  <div>
                    <dt>Character</dt>
                    <dd>{speechLifecycleCharacterId}</dd>
                  </div>
                </dl>

                <div className="speech-panel__event-grid">
                  <article className="speech-panel__event">
                    <h3>Transcription</h3>
                    <p className="speech-panel__event-status">
                      {canonicalTranscription?.status ?? speechLifecycleSnapshot.canonicalTranscriptionEvent?.status ?? "unavailable"}
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
                      {canonicalSynthesis?.status ?? speechLifecycleSnapshot.canonicalSpeechSynthesisEvent?.status ?? "unavailable"}
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
        </div>
        <AvatarStage runtime={runtime} selectedCharacter={selectedCharacter} />
      </main>
    </div>
  );
}