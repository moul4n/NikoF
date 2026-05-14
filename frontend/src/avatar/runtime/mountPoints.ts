export interface AvatarRuntimeMountPoints {
  viewportElementId: string;
  overlayElementId: string;
}

const AVATAR_VIEWPORT_MOUNT_ID = "avatar-runtime-viewport";
const AVATAR_OVERLAY_MOUNT_ID = "avatar-runtime-overlay";
const AVATAR_RUNTIME_MOUNT_POINTS: AvatarRuntimeMountPoints = {
  viewportElementId: AVATAR_VIEWPORT_MOUNT_ID,
  overlayElementId: AVATAR_OVERLAY_MOUNT_ID
};

export function getAvatarRuntimeMountPoints(): AvatarRuntimeMountPoints {
  return AVATAR_RUNTIME_MOUNT_POINTS;
}