import { useEffect, useState } from "react";
import {
  FaceDetector as MediaPipeFaceDetector,
  FilesetResolver,
  PoseLandmarker,
  type Detection,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

interface BrowserCameraDevice {
  deviceId: string;
  label: string;
  default: boolean;
}

type AttentionCaptureStatus = "idle" | "enumerating" | "requesting" | "capturing" | "unsupported" | "error";

interface AttentionCaptureState {
  status: AttentionCaptureStatus;
  devices: BrowserCameraDevice[];
  message: string | null;
}

interface AttentionCaptureOptions {
  enabled: boolean;
  tracking: boolean;
  selectedDeviceId: string | null;
  selectedDeviceLabel: string | null;
}

interface BrowserFace {
  boundingBox: DOMRectReadOnly;
}

interface BrowserFaceDetector {
  detect(input: HTMLVideoElement): Promise<BrowserFace[]>;
}

interface BrowserFaceDetectorConstructor {
  new (options?: { fastMode?: boolean; maxDetectedFaces?: number }): BrowserFaceDetector;
}

interface AttentionDetectionSnapshot {
  normalizedX: number;
  normalizedY: number;
  confidence: number;
  subjectWidth: number | null;
  subjectHeight: number | null;
}

interface AttentionDetectorSuite {
  label: string;
  detect(video: HTMLVideoElement, timestampMs: number): Promise<AttentionDetectionSnapshot | null>;
}

const OBSERVATION_ROUTE_PATH = "/session/attention/observations";
const TARGET_FRAME_WIDTH = 320;
const TARGET_FRAME_HEIGHT = 240;
const TARGET_INTERVAL_MS = 125;
const MEDIAPIPE_TASKS_VERSION = "0.10.35";
const MEDIAPIPE_WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VERSION}/wasm`;
const MEDIAPIPE_FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const MEDIAPIPE_POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const MIN_POSE_VISIBILITY = 0.35;
const POSE_INDEX_NOSE = 0;
const POSE_INDEX_LEFT_SHOULDER = 11;
const POSE_INDEX_RIGHT_SHOULDER = 12;
const POSE_INDEX_LEFT_HIP = 23;
const POSE_INDEX_RIGHT_HIP = 24;

let detectorSuitePromise: Promise<AttentionDetectorSuite> | null = null;

function resolveConfiguredApiBase(): string {
  const configuredBaseUrl = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_BACKEND_API_BASE_URL?.trim();

  if (!configuredBaseUrl) {
    return "/api";
  }

  return configuredBaseUrl.replace(/\/+$/, "");
}

function buildBackendUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${resolveConfiguredApiBase()}${normalizedPath}`;
}

function getFaceDetectorConstructor(): BrowserFaceDetectorConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }

  return (window as Window & { FaceDetector?: BrowserFaceDetectorConstructor }).FaceDetector ?? null;
}

function describeCaptureError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Camera permission was denied by the browser.";
    }
    if (error.name === "NotFoundError") {
      return "No browser camera was available for live attention capture.";
    }
    if (error.name === "OverconstrainedError") {
      return "The selected camera could not satisfy the requested capture settings.";
    }
  }

  return error instanceof Error ? error.message : "Browser camera capture failed.";
}

async function postObservation(payload: Record<string, unknown>): Promise<void> {
  await fetch(buildBackendUrl(OBSERVATION_ROUTE_PATH), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function postUntrackedObservation(deviceId: string, deviceLabel: string, frameWidth: number, frameHeight: number): Promise<void> {
  await postObservation({
    schema_version: 1,
    device_id: deviceId,
    device_label: deviceLabel,
    captured_at: Date.now() / 1000,
    frame_width: frameWidth,
    frame_height: frameHeight,
    subject: {
      tracked: false,
      confidence: 0,
    },
  });
}

function clampNormalized(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function pickPreferredFace(faces: BrowserFace[]): BrowserFace | null {
  if (faces.length === 0) {
    return null;
  }

  return [...faces].sort((left, right) => {
    const leftArea = left.boundingBox.width * left.boundingBox.height;
    const rightArea = right.boundingBox.width * right.boundingBox.height;
    return rightArea - leftArea;
  })[0] ?? null;
}

function pickPreferredMediaPipeFace(detections: Detection[]): Detection | null {
  if (detections.length === 0) {
    return null;
  }

  return [...detections].sort((left, right) => {
    const leftBox = left.boundingBox;
    const rightBox = right.boundingBox;
    const leftArea = leftBox ? leftBox.width * leftBox.height : 0;
    const rightArea = rightBox ? rightBox.width * rightBox.height : 0;
    return rightArea - leftArea;
  })[0] ?? null;
}

function buildFaceDetectionSnapshot(
  originX: number,
  originY: number,
  width: number,
  height: number,
  frameWidth: number,
  frameHeight: number,
  confidence: number,
): AttentionDetectionSnapshot {
  return {
    normalizedX: clampNormalized((originX + width * 0.5) / frameWidth),
    normalizedY: clampNormalized((originY + height * 0.5) / frameHeight),
    confidence: Math.max(0.45, Math.min(0.98, confidence)),
    subjectWidth: Math.max(0, Math.min(1, width / frameWidth)),
    subjectHeight: Math.max(0, Math.min(1, height / frameHeight)),
  };
}

function getVisiblePoseLandmark(landmarks: NormalizedLandmark[], index: number): NormalizedLandmark | null {
  const landmark = landmarks[index];
  if (!landmark || landmark.visibility < MIN_POSE_VISIBILITY) {
    return null;
  }

  return landmark;
}

function buildPoseDetectionSnapshot(landmarks: NormalizedLandmark[]): AttentionDetectionSnapshot | null {
  const nose = getVisiblePoseLandmark(landmarks, POSE_INDEX_NOSE);
  const leftShoulder = getVisiblePoseLandmark(landmarks, POSE_INDEX_LEFT_SHOULDER);
  const rightShoulder = getVisiblePoseLandmark(landmarks, POSE_INDEX_RIGHT_SHOULDER);
  const leftHip = getVisiblePoseLandmark(landmarks, POSE_INDEX_LEFT_HIP);
  const rightHip = getVisiblePoseLandmark(landmarks, POSE_INDEX_RIGHT_HIP);

  if (nose) {
    const shoulderWidth = leftShoulder && rightShoulder ? Math.abs(rightShoulder.x - leftShoulder.x) : 0.18;
    const torsoHeight = leftHip && rightHip && leftShoulder && rightShoulder
      ? Math.abs(((leftHip.y + rightHip.y) * 0.5) - ((leftShoulder.y + rightShoulder.y) * 0.5))
      : 0.28;

    return {
      normalizedX: clampNormalized(nose.x),
      normalizedY: clampNormalized(nose.y),
      confidence: Math.max(0.52, Math.min(0.82, nose.visibility)),
      subjectWidth: Math.max(0.08, Math.min(0.7, shoulderWidth)),
      subjectHeight: Math.max(0.12, Math.min(0.85, torsoHeight)),
    };
  }

  if (!leftShoulder || !rightShoulder) {
    return null;
  }

  const shoulderCenterX = (leftShoulder.x + rightShoulder.x) * 0.5;
  const shoulderCenterY = (leftShoulder.y + rightShoulder.y) * 0.5;
  const shoulderWidth = Math.abs(rightShoulder.x - leftShoulder.x);
  const hipCenterY = leftHip && rightHip ? (leftHip.y + rightHip.y) * 0.5 : shoulderCenterY + 0.25;
  const torsoHeight = Math.max(0.16, Math.abs(hipCenterY - shoulderCenterY));
  const upperBodyCenterY = shoulderCenterY - torsoHeight * 0.28;
  const visibilityConfidence = [leftShoulder.visibility, rightShoulder.visibility, leftHip?.visibility ?? 0.45, rightHip?.visibility ?? 0.45]
    .reduce((sum, value) => sum + value, 0) / 4;

  return {
    normalizedX: clampNormalized(shoulderCenterX),
    normalizedY: clampNormalized(upperBodyCenterY),
    confidence: Math.max(0.48, Math.min(0.78, visibilityConfidence)),
    subjectWidth: Math.max(0.1, Math.min(0.8, shoulderWidth)),
    subjectHeight: Math.max(0.16, Math.min(0.95, torsoHeight * 1.8)),
  };
}

async function createAttentionDetectorSuite(): Promise<AttentionDetectorSuite> {
  const nativeFaceCtor = getFaceDetectorConstructor();
  const nativeFaceDetector = nativeFaceCtor ? new nativeFaceCtor({ fastMode: true, maxDetectedFaces: 1 }) : null;
  let mediaPipeFaceDetector: MediaPipeFaceDetector | null = null;
  let mediaPipePoseLandmarker: PoseLandmarker | null = null;
  const availableDetectors: string[] = [];

  if (nativeFaceDetector) {
    availableDetectors.push("browser face");
  }

  try {
    const wasmFileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
    mediaPipeFaceDetector = await MediaPipeFaceDetector.createFromOptions(wasmFileset, {
      baseOptions: {
        modelAssetPath: MEDIAPIPE_FACE_MODEL_URL,
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.45,
      minSuppressionThreshold: 0.3,
    });
    mediaPipePoseLandmarker = await PoseLandmarker.createFromOptions(wasmFileset, {
      baseOptions: {
        modelAssetPath: MEDIAPIPE_POSE_MODEL_URL,
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.45,
      minPosePresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
      outputSegmentationMasks: false,
    });
    availableDetectors.push("MediaPipe face", "MediaPipe body");
  } catch (error: unknown) {
    if (!nativeFaceDetector) {
      throw new Error(error instanceof Error ? error.message : "Vision detector initialization failed.");
    }
  }

  if (!nativeFaceDetector && !mediaPipeFaceDetector && !mediaPipePoseLandmarker) {
    throw new Error("No supported face or body detector could be initialized in this browser.");
  }

  return {
    label: availableDetectors.join(" + "),
    async detect(video: HTMLVideoElement, timestampMs: number): Promise<AttentionDetectionSnapshot | null> {
      const frameWidth = video.videoWidth || TARGET_FRAME_WIDTH;
      const frameHeight = video.videoHeight || TARGET_FRAME_HEIGHT;

      if (nativeFaceDetector) {
        const nativeFaces = await nativeFaceDetector.detect(video);
        const chosenNativeFace = pickPreferredFace(nativeFaces);
        if (chosenNativeFace) {
          return buildFaceDetectionSnapshot(
            chosenNativeFace.boundingBox.x,
            chosenNativeFace.boundingBox.y,
            chosenNativeFace.boundingBox.width,
            chosenNativeFace.boundingBox.height,
            frameWidth,
            frameHeight,
            0.88,
          );
        }
      }

      if (mediaPipeFaceDetector) {
        const mediaPipeFaceResult = mediaPipeFaceDetector.detectForVideo(video, timestampMs);
        const chosenMediaPipeFace = pickPreferredMediaPipeFace(mediaPipeFaceResult.detections);
        const faceBox = chosenMediaPipeFace?.boundingBox;
        if (chosenMediaPipeFace && faceBox) {
          return buildFaceDetectionSnapshot(
            faceBox.originX,
            faceBox.originY,
            faceBox.width,
            faceBox.height,
            frameWidth,
            frameHeight,
            chosenMediaPipeFace.categories[0]?.score ?? 0.82,
          );
        }
      }

      if (mediaPipePoseLandmarker) {
        const poseResult = mediaPipePoseLandmarker.detectForVideo(video, timestampMs);
        const poseLandmarks = poseResult.landmarks[0] ?? null;
        if (poseLandmarks) {
          return buildPoseDetectionSnapshot(poseLandmarks);
        }
      }

      return null;
    },
  };
}

function loadAttentionDetectorSuite(): Promise<AttentionDetectorSuite> {
  if (!detectorSuitePromise) {
    detectorSuitePromise = createAttentionDetectorSuite().catch((error) => {
      detectorSuitePromise = null;
      throw error;
    });
  }

  return detectorSuitePromise;
}

export function useAttentionCapture({
  enabled,
  tracking,
  selectedDeviceId,
  selectedDeviceLabel,
}: AttentionCaptureOptions): AttentionCaptureState {
  const [state, setState] = useState<AttentionCaptureState>({
    status: "idle",
    devices: [],
    message: null,
  });

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      setState({
        status: "unsupported",
        devices: [],
        message: "Browser camera APIs are unavailable in this environment.",
      });
      return;
    }

    let cancelled = false;

    async function refreshDevices(): Promise<void> {
      setState((currentState) => ({ ...currentState, status: currentState.status === "capturing" ? currentState.status : "enumerating" }));
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) {
          return;
        }

        const cameras = devices
          .filter((device) => device.kind === "videoinput")
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Camera ${index + 1}`,
            default: device.deviceId === "default" || index === 0,
          }));

        setState((currentState) => ({
          status: currentState.status === "capturing" ? currentState.status : "idle",
          devices: cameras,
          message: cameras.length === 0 ? "No browser camera devices detected yet." : currentState.message,
        }));
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }

        setState((currentState) => ({
          ...currentState,
          status: "error",
          message: error instanceof Error ? error.message : "Browser camera enumeration failed.",
        }));
      }
    }

    void refreshDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", refreshDevices);

    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refreshDevices);
    };
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      return;
    }

    if (!enabled || !tracking) {
      setState((currentState) => ({
        ...currentState,
        status: currentState.status === "unsupported" ? currentState.status : "idle",
        message: currentState.status === "unsupported" ? currentState.message : null,
      }));
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;
    let stream: MediaStream | null = null;
    let detectionInFlight = false;
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    async function startCapture(): Promise<void> {
      setState((currentState) => ({ ...currentState, status: "requesting", message: null }));

      try {
        const preferredDeviceId = selectedDeviceId && selectedDeviceId !== "camera-default" ? selectedDeviceId : null;
        const preferredConstraints = preferredDeviceId
          ? {
              audio: false,
              video: {
                deviceId: { exact: preferredDeviceId },
                width: { ideal: TARGET_FRAME_WIDTH },
                height: { ideal: TARGET_FRAME_HEIGHT },
              },
            }
          : {
              audio: false,
              video: {
                width: { ideal: TARGET_FRAME_WIDTH },
                height: { ideal: TARGET_FRAME_HEIGHT },
              },
            };

        try {
          stream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
        } catch (error: unknown) {
          if (!preferredDeviceId) {
            throw error;
          }

          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              width: { ideal: TARGET_FRAME_WIDTH },
              height: { ideal: TARGET_FRAME_HEIGHT },
            },
          });
        }

        if (cancelled || !stream) {
          return;
        }

        video.srcObject = stream;
        await video.play().catch(() => undefined);

        const trackSettings = stream.getVideoTracks()[0]?.getSettings();
        const actualDeviceId = trackSettings?.deviceId ?? selectedDeviceId ?? "camera-default";
        const actualDeviceLabel = selectedDeviceLabel ?? stream.getVideoTracks()[0]?.label ?? "Browser camera";
        const frameWidth = video.videoWidth || TARGET_FRAME_WIDTH;
        const frameHeight = video.videoHeight || TARGET_FRAME_HEIGHT;
        const detectorSuite = await loadAttentionDetectorSuite();

        setState((currentState) => ({
          ...currentState,
          status: "capturing",
          message: `Capturing low-rate face/body observations from ${actualDeviceLabel} using ${detectorSuite.label}.`,
        }));

        intervalId = window.setInterval(() => {
          if (detectionInFlight) {
            return;
          }

          detectionInFlight = true;
          void detectAndPost(detectorSuite, video, actualDeviceId, actualDeviceLabel)
            .finally(() => {
              detectionInFlight = false;
            });
        }, TARGET_INTERVAL_MS);
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }

        setState((currentState) => ({
          ...currentState,
          status: "error",
          message: describeCaptureError(error),
        }));
      }
    }

    async function detectAndPost(
      detectorSuite: AttentionDetectorSuite,
      activeVideo: HTMLVideoElement,
      deviceId: string,
      deviceLabel: string,
    ): Promise<void> {
      if (cancelled || activeVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }

      try {
        const frameWidth = activeVideo.videoWidth || TARGET_FRAME_WIDTH;
        const frameHeight = activeVideo.videoHeight || TARGET_FRAME_HEIGHT;
        const detection = await detectorSuite.detect(activeVideo, performance.now());

        if (!detection) {
          await postUntrackedObservation(deviceId, deviceLabel, frameWidth, frameHeight);
          return;
        }

        await postObservation({
          schema_version: 1,
          device_id: deviceId,
          device_label: deviceLabel,
          captured_at: Date.now() / 1000,
          frame_width: frameWidth,
          frame_height: frameHeight,
          subject: {
            tracked: true,
            normalized_x: detection.normalizedX,
            normalized_y: detection.normalizedY,
            face_width: detection.subjectWidth,
            face_height: detection.subjectHeight,
            confidence: detection.confidence,
          },
        });
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }

        setState((currentState) => ({
          ...currentState,
          status: "error",
          message: error instanceof Error ? error.message : "Attention face detection failed.",
        }));
      }
    }

    void startCapture();

    return () => {
      cancelled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
      video.srcObject = null;
    };
  }, [enabled, selectedDeviceId, selectedDeviceLabel, tracking]);

  return state;
}