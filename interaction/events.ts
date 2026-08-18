import type { FaceState } from "../lib/faceState";

export type { FaceState } from "../lib/faceState";

export interface InteractionEventBase<TType extends string, TPayload> {
  type: TType;
  timestamp: number;
  payload: TPayload;
}

export type CameraState = "disabled" | "starting" | "active" | "error";
export type GestureName = "spin" | "zoom";

export type GestureDetectedEvent =
  | InteractionEventBase<
      "gesture.detected",
      {
        source: "mediapipe";
        gesture: "spin";
        hands: number;
        deltaTheta: number;
        deltaPhi: number;
      }
    >
  | InteractionEventBase<
      "gesture.detected",
      {
        source: "mediapipe";
        gesture: "zoom";
        hands: number;
        factor: number;
      }
    >;

export type CameraStateChangedEvent = InteractionEventBase<
  "camera.state_changed",
  {
    state: CameraState;
    reason?: string;
  }
>;

/**
 * Shared vocabulary used by face, gesture, camera, voice, clap, auth, and HUD adapters.
 * Payloads intentionally contain only serializable data.
 */
export interface InteractionEventMap {
  "camera.state_changed": CameraStateChangedEvent;
  "gesture.detected": GestureDetectedEvent;
  "face.state_changed": InteractionEventBase<
    "face.state_changed",
    { previous: FaceState; state: FaceState; intensity?: number }
  >;
  "face.signals_changed": InteractionEventBase<
    "face.signals_changed",
    { audioLevel?: number; gestureEnergy?: number; intensity?: number }
  >;
  "face.renderer_status": InteractionEventBase<
    "face.renderer_status",
    { status: "ready" | "error" | "lost" | "restored"; message?: string }
  >;
  "voice.wake_detected": InteractionEventBase<
    "voice.wake_detected",
    { phrase: string; confidence?: number }
  >;
  "voice.listening": InteractionEventBase<"voice.listening", { active: boolean }>;
  "voice.transcribing": InteractionEventBase<"voice.transcribing", { active: boolean }>;
  "voice.speaking": InteractionEventBase<"voice.speaking", { active: boolean }>;
  "clap.double_detected": InteractionEventBase<
    "clap.double_detected",
    { intervalMs: number; confidence?: number }
  >;
  "clap.activation_detected": InteractionEventBase<
    "clap.activation_detected",
    { clapCount: 1 | 2; intervalMs: number; confidence?: number }
  >;
  "auth.started": InteractionEventBase<
    "auth.started",
    { activationMethod: "double_clap" | "manual" | "voice" }
  >;
  "auth.speaker_verified": InteractionEventBase<
    "auth.speaker_verified",
    { speakerSimilarity: number }
  >;
  "auth.challenge_passed": InteractionEventBase<
    "auth.challenge_passed",
    { speechMatch: number; livenessConfidence: number }
  >;
  "auth.failed": InteractionEventBase<
    "auth.failed",
    {
      reason:
        | "speaker_mismatch"
        | "challenge_mismatch"
        | "replay_suspected"
        | "microphone_unavailable"
        | "timeout"
        | "throttled"
        | "unknown";
    }
  >;
  "auth.prototype_verified": InteractionEventBase<"auth.prototype_verified", Record<string, never>>;
  "activation.rejected": InteractionEventBase<
    "activation.rejected",
    { reason: "lock_state_unknown" | "microphone_unavailable" | "unknown" }
  >;
  "hud.open_requested": InteractionEventBase<
    "hud.open_requested",
    {
      reason: "double_clap" | "gesture" | "manual" | "system" | "voice";
      enterListening: boolean;
    }
  >;
}

type EventMapShape<TMap> = {
  [K in keyof TMap]: InteractionEventBase<Extract<K, string>, unknown>;
};

export type InteractionEvent = InteractionEventMap[keyof InteractionEventMap];
export type InteractionEventListener<TEvent> = (event: TEvent) => void;

/** A synchronous in-process bus for normalized interaction events. */
export class InteractionEventBus<
  TMap extends EventMapShape<TMap> = InteractionEventMap,
> {
  private readonly onListenerError: (error: unknown, type: keyof TMap) => void;

  constructor(onListenerError?: (error: unknown, type: keyof TMap) => void) {
    this.onListenerError =
      onListenerError ??
      ((error, type) => console.error(`Interaction listener failed for ${String(type)}`, error));
  }

  private readonly listeners = new Map<
    keyof TMap,
    Set<InteractionEventListener<TMap[keyof TMap]>>
  >();

  on<K extends keyof TMap>(
    type: K,
    listener: InteractionEventListener<TMap[K]>,
  ): () => void {
    let listenersForType = this.listeners.get(type);
    if (!listenersForType) {
      listenersForType = new Set();
      this.listeners.set(type, listenersForType);
    }
    listenersForType.add(
      listener as InteractionEventListener<TMap[keyof TMap]>,
    );
    return () => this.off(type, listener);
  }

  off<K extends keyof TMap>(
    type: K,
    listener: InteractionEventListener<TMap[K]>,
  ): void {
    const listenersForType = this.listeners.get(type);
    if (!listenersForType) return;
    listenersForType.delete(
      listener as InteractionEventListener<TMap[keyof TMap]>,
    );
    if (listenersForType.size === 0) this.listeners.delete(type);
  }

  emit<K extends keyof TMap>(event: TMap[K]): void {
    const type = event.type as K;
    const listenersForType = this.listeners.get(type);
    if (!listenersForType) return;
    for (const listener of [...listenersForType]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error, type);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const interactionEventBus = new InteractionEventBus();
