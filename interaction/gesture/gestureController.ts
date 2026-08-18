export type GestureMode = "idle" | "spin" | "zoom";

export interface TrackerStatus {
  hands: number;
  mode: GestureMode;
}

export interface GesturePoint {
  x: number;
  y: number;
}

export interface HandGestureObservation {
  id: string;
  pinchRatio: number;
  grab: GesturePoint;
}

export type GestureIntent =
  | { kind: "spin"; deltaTheta: number; deltaPhi: number }
  | { kind: "zoom"; factor: number };

export interface GestureFrameResult {
  status: TrackerStatus;
  intent: GestureIntent | null;
}

export interface GestureControllerOptions {
  pinchOn: number;
  pinchOff: number;
  rotateSpeed: number;
  smoothing: number;
  minimumMovement: number;
  minimumZoomDistance: number;
  minimumZoomFactor: number;
  maximumZoomFactor: number;
}

export const DEFAULT_GESTURE_OPTIONS: Readonly<GestureControllerOptions> = {
  pinchOn: 0.32,
  pinchOff: 0.45,
  rotateSpeed: 5,
  smoothing: 0.4,
  minimumMovement: 1e-4,
  minimumZoomDistance: 1e-4,
  minimumZoomFactor: 0.85,
  maximumZoomFactor: 1.18,
};

interface HandState {
  pinching: boolean;
  grab: GesturePoint;
}

export function classifyGestureMode(pinchedHands: number): GestureMode {
  if (pinchedHands >= 2) return "zoom";
  if (pinchedHands === 1) return "spin";
  return "idle";
}

/**
 * Converts normalized hand observations into the two original Ultron intents.
 * It knows nothing about MediaPipe, the camera, React, or the face renderer.
 */
export class GestureController {
  private readonly options: GestureControllerOptions;
  private readonly handStates = new Map<string, HandState>();
  private previousMode: GestureMode = "idle";
  private previousSpinGrab: GesturePoint | null = null;
  private previousZoomDistance: number | null = null;

  constructor(options: Partial<GestureControllerOptions> = {}) {
    this.options = { ...DEFAULT_GESTURE_OPTIONS, ...options };
  }

  update(
    observations: readonly HandGestureObservation[],
    handsDetected = observations.length,
  ): GestureFrameResult {
    const pinchedGrabs: GesturePoint[] = [];
    const seen = new Set<string>();

    for (const observation of observations) {
      seen.add(observation.id);
      let state = this.handStates.get(observation.id);
      if (!state) {
        state = { pinching: false, grab: observation.grab };
        this.handStates.set(observation.id, state);
      }

      if (state.pinching && observation.pinchRatio > this.options.pinchOff) {
        state.pinching = false;
      } else if (
        !state.pinching &&
        observation.pinchRatio < this.options.pinchOn
      ) {
        state.pinching = true;
      }

      state.grab = {
        x:
          state.grab.x +
          (observation.grab.x - state.grab.x) * this.options.smoothing,
        y:
          state.grab.y +
          (observation.grab.y - state.grab.y) * this.options.smoothing,
      };
      if (state.pinching) pinchedGrabs.push(state.grab);
    }

    for (const id of this.handStates.keys()) {
      if (!seen.has(id)) this.handStates.delete(id);
    }

    const mode = classifyGestureMode(pinchedGrabs.length);
    if (mode !== this.previousMode) {
      this.previousSpinGrab = null;
      this.previousZoomDistance = null;
      this.previousMode = mode;
    }

    let intent: GestureIntent | null = null;
    if (mode === "spin") {
      const grab = pinchedGrabs[0];
      if (this.previousSpinGrab) {
        const dx = grab.x - this.previousSpinGrab.x;
        const dy = grab.y - this.previousSpinGrab.y;
        if (
          Math.abs(dx) > this.options.minimumMovement ||
          Math.abs(dy) > this.options.minimumMovement
        ) {
          intent = {
            kind: "spin",
            deltaTheta: dx * this.options.rotateSpeed,
            deltaPhi: dy * this.options.rotateSpeed,
          };
        }
      }
      this.previousSpinGrab = grab;
    } else if (mode === "zoom") {
      const distance = Math.hypot(
        pinchedGrabs[0].x - pinchedGrabs[1].x,
        pinchedGrabs[0].y - pinchedGrabs[1].y,
      );
      if (
        this.previousZoomDistance !== null &&
        this.previousZoomDistance > this.options.minimumZoomDistance &&
        distance > this.options.minimumZoomDistance
      ) {
        intent = {
          kind: "zoom",
          factor: Math.min(
            this.options.maximumZoomFactor,
            Math.max(
              this.options.minimumZoomFactor,
              this.previousZoomDistance / distance,
            ),
          ),
        };
      }
      this.previousZoomDistance = distance;
    }

    return { status: { hands: handsDetected, mode }, intent };
  }

  reset(): void {
    this.handStates.clear();
    this.previousMode = "idle";
    this.previousSpinGrab = null;
    this.previousZoomDistance = null;
  }
}
