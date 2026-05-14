import React, { useEffect } from "react";
import type { CharacterCatalogEntry } from "../../shared/types/character";
import type { AvatarRuntimeBridge } from "../runtime/avatarRuntime";
import { getAvatarRuntimeMountPoints } from "../runtime/mountPoints";

interface AvatarStageProps {
  runtime: AvatarRuntimeBridge;
  selectedCharacter: CharacterCatalogEntry | null;
}

export function AvatarStage({ runtime, selectedCharacter }: AvatarStageProps): JSX.Element {
  const mountPoints = getAvatarRuntimeMountPoints();

  useEffect(() => {
    runtime.mount(mountPoints);

    return () => {
      runtime.unmount();
    };
  }, [mountPoints, runtime]);

  return (
    <section className="avatar-stage" aria-labelledby="avatar-stage-title">
      <div className="avatar-stage__header">
        <div>
          <p className="eyebrow">Avatar runtime</p>
          <h2 id="avatar-stage-title">Viewer mount points</h2>
        </div>
        <span className="avatar-stage__status">{runtime.snapshot().mounted ? "mounted" : "pending mount"}</span>
      </div>

      <div className="avatar-stage__surface">
        <div id={mountPoints.viewportElementId} className="avatar-stage__viewport">
          <p>three.js plus three-vrm runtime will attach here in Phase 1.</p>
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
                <dd>{selectedCharacter.summary.assets.modelUrl}</dd>
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