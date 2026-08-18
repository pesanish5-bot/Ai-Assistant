import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import {
  DEFAULT_GESTURE_OPTIONS,
  GestureController,
  type GestureMode,
  type HandGestureObservation,
  type TrackerStatus,
} from "../interaction/gesture/gestureController.ts";
import {
  interactionEventBus,
  type InteractionEventBus,
} from "../interaction/events.ts";

export type { GestureMode, TrackerStatus };

// Reviewed, version-pinned assets are served from this loopback application.
// Camera initialization performs no runtime CDN or model download.
const WASM_ROOT = "/mediapipe/wasm";
const MODEL_URL = "/mediapipe/hand_landmarker.task";

// Landmark indices (MediaPipe hand model)
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;

export interface HandTrackerCallbacks {
  /** Called when a single pinched hand drags: deltas in mirrored normalized coords. */
  onRotate(deltaTheta: number, deltaPhi: number): void;
  /** Called when both hands pinch and spread/close: multiply camera distance by factor. */
  onZoom(factor: number): void;
  onStatus(status: TrackerStatus): void;
  /** A runtime camera/model failure after successful initialization. */
  onError(error: unknown): void;
}

export class HandTracker {
  private video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private callbacks: HandTrackerCallbacks;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private running = false;
  private generation = 0;
  private lastVideoTime = -1;
  private trackEndedHandler: (() => void) | null = null;
  private failureReported = false;

  private gestureController = new GestureController();
  private lastStatus: TrackerStatus = { hands: 0, mode: "idle" };
  private events: InteractionEventBus;

  constructor(
    video: HTMLVideoElement,
    overlay: HTMLCanvasElement,
    callbacks: HandTrackerCallbacks,
    events: InteractionEventBus = interactionEventBus,
  ) {
    this.video = video;
    this.overlay = overlay;
    this.callbacks = callbacks;
    this.events = events;
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    this.failureReported = false;
    this.trackEndedHandler = () => this.failRuntime(new Error("Camera stream ended"));
    for (const track of stream.getVideoTracks()) {
      track.addEventListener("ended", this.trackEndedHandler, { once: true });
    }
    this.video.srcObject = stream;
    await this.video.play();
    if (generation !== this.generation) return this.disposeLateStart(stream);

    const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
    if (generation !== this.generation) return this.disposeLateStart(stream);
    const options = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" as const },
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    };
    try {
      const landmarker = await HandLandmarker.createFromOptions(fileset, options);
      if (generation !== this.generation) {
        landmarker.close();
        return this.disposeLateStart(stream);
      }
      this.landmarker = landmarker;
    } catch {
      // Some browsers/GPUs reject the GPU delegate — fall back to CPU
      if (generation !== this.generation) return this.disposeLateStart(stream);
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: "CPU" as const },
      });
      if (generation !== this.generation) {
        landmarker.close();
        return this.disposeLateStart(stream);
      }
      this.landmarker = landmarker;
    }

    if (generation !== this.generation) return this.disposeLateStart(stream);
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.generation += 1;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.landmarker?.close();
    this.landmarker = null;
    if (this.trackEndedHandler) {
      this.stream?.getVideoTracks().forEach((track) =>
        track.removeEventListener("ended", this.trackEndedHandler!),
      );
    }
    this.trackEndedHandler = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.gestureController.reset();
    this.lastVideoTime = -1;
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.emitStatus({ hands: 0, mode: "idle" });
  }

  private disposeLateStart(stream: MediaStream): void {
    if (this.trackEndedHandler) {
      stream.getVideoTracks().forEach((track) =>
        track.removeEventListener("ended", this.trackEndedHandler!),
      );
      this.trackEndedHandler = null;
    }
    stream.getTracks().forEach((track) => track.stop());
    if (this.stream === stream) this.stream = null;
    if (this.video.srcObject === stream) this.video.srcObject = null;
  }

  private loop = () => {
    if (!this.running) return;
    try {
      if (this.landmarker && this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = this.video.currentTime;
        const result = this.landmarker.detectForVideo(this.video, performance.now());
        this.processHands(result.landmarks, result.handedness.map((h) => h[0]?.categoryName ?? "?"));
        this.drawOverlay(result.landmarks);
      }
    } catch (error) {
      this.failRuntime(error);
      return;
    }
    if (this.running) this.rafId = requestAnimationFrame(this.loop);
  };

  private failRuntime(error: unknown): void {
    if (this.failureReported) return;
    this.failureReported = true;
    this.stop();
    this.callbacks.onError(error);
  }

  private processHands(
    landmarks: NormalizedLandmark[][],
    labels: string[],
  ): void {
    const observations: HandGestureObservation[] = [];

    landmarks.forEach((lm, i) => {
      const label = labels[i];

      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      if (handScale < 1e-6) return;
      const pinchRatio = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale;

      observations.push({
        id: label,
        pinchRatio,
        // Mirrored so hand-right = screen-right from the user's perspective.
        grab: {
          x: 1 - (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
          y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
        },
      });
    });

    const result = this.gestureController.update(observations, landmarks.length);
    if (result.intent?.kind === "spin") {
      this.callbacks.onRotate(
        result.intent.deltaTheta,
        result.intent.deltaPhi,
      );
      this.events.emit({
        type: "gesture.detected",
        timestamp: Date.now(),
        payload: {
          source: "mediapipe",
          gesture: "spin",
          hands: result.status.hands,
          deltaTheta: result.intent.deltaTheta,
          deltaPhi: result.intent.deltaPhi,
        },
      });
    } else if (result.intent?.kind === "zoom") {
      this.callbacks.onZoom(result.intent.factor);
      this.events.emit({
        type: "gesture.detected",
        timestamp: Date.now(),
        payload: {
          source: "mediapipe",
          gesture: "zoom",
          hands: result.status.hands,
          factor: result.intent.factor,
        },
      });
    }

    this.emitStatus(result.status);
  }

  private emitStatus(status: TrackerStatus): void {
    if (
      status.hands !== this.lastStatus.hands ||
      status.mode !== this.lastStatus.mode
    ) {
      this.lastStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  private drawOverlay(landmarks: NormalizedLandmark[][]): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    for (const lm of landmarks) {
      const thumb = lm[THUMB_TIP];
      const index = lm[INDEX_TIP];
      // Overlay canvas sits on the mirrored video preview, so mirror x here too
      const tx = (1 - thumb.x) * width;
      const ty = thumb.y * height;
      const ix = (1 - index.x) * width;
      const iy = index.y * height;

      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      const pinched =
        handScale > 1e-6 &&
        dist2d(thumb, index) / handScale < DEFAULT_GESTURE_OPTIONS.pinchOn;

      ctx.strokeStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.5)";
      ctx.lineWidth = pinched ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ix, iy);
      ctx.stroke();

      ctx.fillStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.7)";
      for (const [x, y] of [
        [tx, ty],
        [ix, iy],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, pinched ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function dist2d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
