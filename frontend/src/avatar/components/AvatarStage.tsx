import React, { useEffect, useState } from "react";
import type { CharacterCatalogEntry } from "../../shared/types/character";
import type { AvatarRuntimeBridge } from "../runtime/avatarRuntime";
import { getAvatarRuntimeMountPoints } from "../runtime/mountPoints";

interface AvatarStageProps {
  runtime: AvatarRuntimeBridge;
  selectedCharacter: CharacterCatalogEntry | null;
  variant?: "embedded" | "display";
}

export function AvatarStage({ runtime, selectedCharacter, variant = "embedded" }: AvatarStageProps): JSX.Element {
  const mountPoints = getAvatarRuntimeMountPoints();
  const [snapshot, setSnapshot] = useState(() => runtime.snapshot());

  useEffect(() => {
    setSnapshot(runtime.snapshot());

    return runtime.subscribe(() => {
      setSnapshot(runtime.snapshot());
    });
  }, [runtime]);

  useEffect(() => {
    runtime.mount(mountPoints);

    return () => {
      runtime.unmount();
    };
  }, [mountPoints, runtime]);

  const runtimeStatusLabel =
    snapshot.loadState === "loading"
      ? "loading vrm"
      : snapshot.loadState === "ready"
        ? "vrm ready"
        : snapshot.loadState === "error"
          ? "load failed"
          : snapshot.mounted
            ? "mounted"
            : "pending mount";
  const runtimeActivityLabel =
    snapshot.currentState === "speak"
      ? snapshot.speechReactionMode === "viseme"
        ? snapshot.activeViseme
          ? `speaking · viseme ${snapshot.activeViseme}`
          : "speaking · viseme"
        : "speaking · coarse"
      : snapshot.currentState;
  const headerStatusLabel = snapshot.currentState === "speak" ? `${runtimeStatusLabel} · ${runtimeActivityLabel}` : runtimeStatusLabel;

  const shellTitle = variant === "display" ? "Dedicated avatar render window" : "Default character shell";
  const shellEyebrow = variant === "display" ? "Display surface" : "Avatar runtime";
  const emptySelectionMessage =
    variant === "display"
      ? "The display surface is ready to mount the backend-confirmed character once one is selected."
      : "Select the default character to mount the runtime.";
  const readyMessage =
    snapshot.currentState === "speak"
      ? snapshot.speechReactionMode === "viseme"
        ? snapshot.activeViseme
          ? `Backend synthesis timing is driving a local viseme reaction on ${snapshot.activeViseme}.`
          : "Backend synthesis timing is driving a local viseme reaction on the mounted avatar."
        : "Backend synthesis playback is driving the coarse speak fallback for the mounted avatar."
      : variant === "display"
      ? "The display surface is rendering the manifest-resolved VRM."
      : "The default shell is now rendering the imported VRM.";
  const displayCharacterLabel = selectedCharacter?.summary.displayName ?? "Waiting for backend-confirmed selection";

  return (
    <section className={variant === "display" ? "avatar-stage avatar-stage--display" : "avatar-stage"} aria-labelledby="avatar-stage-title">
      <div className={variant === "display" ? "avatar-stage__header avatar-stage__header--display" : "avatar-stage__header"}>
        <div>
          <p className="eyebrow">{shellEyebrow}</p>
          <h2 id="avatar-stage-title">{shellTitle}</h2>
        </div>
        <span className="avatar-stage__status">{headerStatusLabel}</span>
      </div>

      <div className={variant === "display" ? "avatar-stage__surface avatar-stage__surface--display" : "avatar-stage__surface"}>
        <div className={variant === "display" ? "avatar-stage__viewport-shell avatar-stage__viewport-shell--display" : "avatar-stage__viewport-shell"}>
          {variant === "display" ? (
            <div className="avatar-stage__display-banner" aria-label="Display runtime summary">
              <span className="avatar-stage__display-chip">{displayCharacterLabel}</span>
              <span className="avatar-stage__display-chip">{runtimeStatusLabel}</span>
              <span className="avatar-stage__display-chip">{runtimeActivityLabel}</span>
            </div>
          ) : null}
          <div id={mountPoints.viewportElementId} className="avatar-stage__viewport" />
          {!selectedCharacter ? <p className="avatar-stage__viewport-message">{emptySelectionMessage}</p> : null}
          {snapshot.loadState === "loading" ? (
            <p className="avatar-stage__viewport-message avatar-stage__viewport-message--loading">Loading the bundled VRM from the manifest-resolved model URL...</p>
          ) : null}
          {snapshot.error ? <p className="avatar-stage__viewport-message avatar-stage__viewport-message--error">{snapshot.error}</p> : null}
          {snapshot.loadState === "ready" ? <p className="avatar-stage__viewport-message">{readyMessage}</p> : null}
        </div>
        {variant === "display" ? null : (
          <aside id={mountPoints.overlayElementId} className="avatar-stage__overlay">
            <h3>Selected character</h3>
            {selectedCharacter ? (
              <dl>
                <div>
                  <dt>Display name</dt>
                  <dd>{selectedCharacter.summary.displayName}</dd>
                </div>
                <div>
                  <dt>Manifest</dt>
                  <dd>{selectedCharacter.manifestUrl}</dd>
                </div>
                <div>
                  <dt>Model URL</dt>
                  <dd>{snapshot.currentModelUrl ?? selectedCharacter.summary.assets.modelUrl}</dd>
                </div>
                <div>
                  <dt>Runtime status</dt>
                  <dd>{runtimeStatusLabel}</dd>
                </div>
                <div>
                  <dt>Activity</dt>
                  <dd>{runtimeActivityLabel}</dd>
                </div>
                <div>
                  <dt>Shared animation set</dt>
                  <dd>{selectedCharacter.summary.sharedAnimationSet}</dd>
                </div>
              </dl>
            ) : (
              <p>Select a character package to inspect its resolved runtime inputs.</p>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}