import React, { useEffect, useState } from "react";
import type { CharacterCatalogEntry } from "../../shared/types/character";
import type { AvatarRuntimeBridge } from "../runtime/avatarRuntime";
import { getAvatarRuntimeMountPoints } from "../runtime/mountPoints";

interface AvatarStageProps {
  runtime: AvatarRuntimeBridge;
  selectedCharacter: CharacterCatalogEntry | null;
}

export function AvatarStage({ runtime, selectedCharacter }: AvatarStageProps): JSX.Element {
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

  return (
    <section className="avatar-stage" aria-labelledby="avatar-stage-title">
      <div className="avatar-stage__header">
        <div>
          <p className="eyebrow">Avatar runtime</p>
          <h2 id="avatar-stage-title">Default character shell</h2>
        </div>
        <span className="avatar-stage__status">{runtimeStatusLabel}</span>
      </div>

      <div className="avatar-stage__surface">
        <div className="avatar-stage__viewport-shell">
          <div id={mountPoints.viewportElementId} className="avatar-stage__viewport" />
          {!selectedCharacter ? <p className="avatar-stage__viewport-message">Select the default character to mount the runtime.</p> : null}
          {snapshot.loadState === "loading" ? (
            <p className="avatar-stage__viewport-message avatar-stage__viewport-message--loading">Loading the bundled VRM from the manifest-resolved model URL...</p>
          ) : null}
          {snapshot.error ? <p className="avatar-stage__viewport-message avatar-stage__viewport-message--error">{snapshot.error}</p> : null}
          {snapshot.loadState === "ready" ? <p className="avatar-stage__viewport-message">The default shell is now rendering the imported VRM.</p> : null}
        </div>
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
                <dt>Shared animation set</dt>
                <dd>{selectedCharacter.summary.sharedAnimationSet}</dd>
              </div>
            </dl>
          ) : (
            <p>Select a character package to inspect its resolved runtime inputs.</p>
          )}
        </aside>
      </div>
    </section>
  );
}