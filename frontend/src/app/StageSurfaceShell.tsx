import React, { useEffect, useState } from "react";
import type { CharacterCatalogEntry } from "../shared/types/character";
import type { AvatarRuntimeBridge } from "../avatar/runtime/avatarRuntime";
import { getAvatarRuntimeMountPoints } from "../avatar/runtime/mountPoints";
import { DEFAULT_STAGE_BACKGROUND_ID } from "../avatar/runtime/backgroundController";
import { getStageBackground } from "../avatar/loaders/stageBackground";

const STAGE_BACKGROUND_POLL_MS = 2500;

interface StageSurfaceShellProps {
  runtime: AvatarRuntimeBridge;
  selectedCharacter: CharacterCatalogEntry | null;
}

/**
 * Wrapperless "stage" surface: just the rendered character filling the window,
 * no operator chrome. This is what the Tauri desktop shell hosts. It reuses the
 * "display" runtime mount points so the higher-fidelity render stack (shadows +
 * tone mapping + bloom) and the portrait framing apply.
 *
 * It is a pure backend-driven client: animations and speech are driven by the
 * shared App orchestration (session animation + speech.lifecycle SSE), so a
 * command issued on the control surface plays through here.
 */
export function StageSurfaceShell({ runtime, selectedCharacter }: StageSurfaceShellProps): JSX.Element {
  const mountPoints = getAvatarRuntimeMountPoints("display");
  const [snapshot, setSnapshot] = useState(() => runtime.snapshot());
  const [backgroundId, setBackgroundId] = useState<string>(DEFAULT_STAGE_BACKGROUND_ID);

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

  // The control surface lives in a separate window/origin, so poll the backend
  // for the selected backdrop and apply it to the renderer (+ the page chrome).
  useEffect(() => {
    let cancelled = false;
    let lastApplied: string | null = null;

    async function pollBackground(): Promise<void> {
      const next = await getStageBackground();
      if (cancelled || !next || next === lastApplied) {
        return;
      }
      lastApplied = next;
      runtime.setBackground(next);
      setBackgroundId(next);
    }

    void pollBackground();
    const timer = window.setInterval(() => void pollBackground(), STAGE_BACKGROUND_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runtime]);

  const statusMessage =
    snapshot.error
      ? snapshot.error
      : snapshot.loadState === "loading"
        ? "Loading character…"
        : !selectedCharacter
          ? "Waiting for a character…"
          : null;

  const isTransparent = backgroundId === "transparent";

  // The page chrome (:root / body) paints opaque gradients; clear them in
  // transparent mode so the see-through canvas reveals what's behind the window.
  useEffect(() => {
    if (!isTransparent) {
      return;
    }
    const root = document.documentElement;
    const body = document.body;
    const previousRoot = root.style.background;
    const previousBody = body.style.background;
    root.style.background = "transparent";
    body.style.background = "transparent";
    return () => {
      root.style.background = previousRoot;
      body.style.background = previousBody;
    };
  }, [isTransparent]);

  return (
    <div
      className={isTransparent ? "stage-surface stage-surface--transparent" : "stage-surface"}
      data-surface-mode="stage"
      data-background={backgroundId}
    >
      <div id={mountPoints.viewportElementId} className="stage-surface__viewport" />
      {statusMessage ? (
        <p
          className={
            snapshot.error
              ? "stage-surface__message stage-surface__message--error"
              : "stage-surface__message"
          }
          role="status"
        >
          {statusMessage}
        </p>
      ) : null}
    </div>
  );
}
