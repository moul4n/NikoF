export interface AvatarRuntimeMountPoints {
  viewportElementId: string;
  overlayElementId: string;
  viewerVariant: "embedded" | "display";
}

const AVATAR_VIEWPORT_MOUNT_ID = "avatar-runtime-viewport";
const AVATAR_OVERLAY_MOUNT_ID = "avatar-runtime-overlay";
const EMBEDDED_AVATAR_RUNTIME_MOUNT_POINTS: AvatarRuntimeMountPoints = {
  viewportElementId: AVATAR_VIEWPORT_MOUNT_ID,
  overlayElementId: AVATAR_OVERLAY_MOUNT_ID,
  viewerVariant: "embedded"
};

const DISPLAY_AVATAR_RUNTIME_MOUNT_POINTS: AvatarRuntimeMountPoints = {
  viewportElementId: AVATAR_VIEWPORT_MOUNT_ID,
  overlayElementId: AVATAR_OVERLAY_MOUNT_ID,
  viewerVariant: "display"
};

export function getAvatarRuntimeMountPoints(viewerVariant: "embedded" | "display" = "embedded"): AvatarRuntimeMountPoints {
  return viewerVariant === "display" ? DISPLAY_AVATAR_RUNTIME_MOUNT_POINTS : EMBEDDED_AVATAR_RUNTIME_MOUNT_POINTS;
}