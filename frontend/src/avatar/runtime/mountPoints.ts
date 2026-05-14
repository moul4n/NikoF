export interface AvatarRuntimeMountPoints {
  viewportElementId: string;
  overlayElementId: string;
}

const AVATAR_VIEWPORT_MOUNT_ID = "avatar-runtime-viewport";
const AVATAR_OVERLAY_MOUNT_ID = "avatar-runtime-overlay";

export function getAvatarRuntimeMountPoints(): AvatarRuntimeMountPoints {
  return {
    viewportElementId: AVATAR_VIEWPORT_MOUNT_ID,
    overlayElementId: AVATAR_OVERLAY_MOUNT_ID
  };
}