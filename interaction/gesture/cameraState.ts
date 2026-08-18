import type { CameraState } from "../events";

export interface CameraReadiness {
  camera: "ACTIVE" | "DISABLED" | "ERROR" | "STARTING";
  gestures: "DISABLED" | "ERROR" | "INITIALIZING" | "READY";
}

const READINESS: Record<CameraState, CameraReadiness> = {
  disabled: { camera: "DISABLED", gestures: "DISABLED" },
  starting: { camera: "STARTING", gestures: "INITIALIZING" },
  active: { camera: "ACTIVE", gestures: "READY" },
  error: { camera: "ERROR", gestures: "ERROR" },
};

export function cameraReadiness(state: CameraState): CameraReadiness {
  return READINESS[state];
}
