import { interactionEventBus } from "../events";
import type { OrbSceneApi } from "../../lib/orbScene";
import { faceController } from "./faceController";

/** Maps normalized interaction events onto the renderer without coupling inputs to Three.js. */
export function bindFaceRenderer(scene: OrbSceneApi): () => void {
  let gestureTimer: ReturnType<typeof setTimeout> | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;

  const unsubscribe = [
    interactionEventBus.on("face.state_changed", ({ payload }) => {
      if (payload.state !== "error" && errorTimer) {
        clearTimeout(errorTimer);
        errorTimer = undefined;
      }
      scene.setState(payload.state);
      if (payload.intensity !== undefined) scene.setIntensity(payload.intensity);
    }),
    interactionEventBus.on("face.signals_changed", ({ payload }) => {
      if (payload.audioLevel !== undefined) scene.setAudioLevel(payload.audioLevel);
      if (payload.gestureEnergy !== undefined) scene.setGestureEnergy(payload.gestureEnergy);
      if (payload.intensity !== undefined) scene.setIntensity(payload.intensity);
    }),
    interactionEventBus.on("gesture.detected", ({ payload }) => {
      const energy =
        payload.gesture === "spin"
          ? Math.min(1, Math.hypot(payload.deltaTheta, payload.deltaPhi) * 2.5)
          : Math.min(1, Math.abs(1 - payload.factor) * 7);
      faceController.setSignals({ gestureEnergy: Math.max(0.28, energy) });
      faceController.setState("gesture_active", 0.72);
      if (gestureTimer) clearTimeout(gestureTimer);
      gestureTimer = setTimeout(() => {
        if (faceController.getState() === "gesture_active") faceController.setState("idle");
      }, 420);
    }),
    interactionEventBus.on("voice.wake_detected", () => {
      faceController.setSignals({ intensity: 1 });
      faceController.setState("listening", 0.9);
    }),
    interactionEventBus.on("voice.listening", ({ payload }) => {
      faceController.setState(payload.active ? "listening" : "idle");
    }),
    interactionEventBus.on("voice.transcribing", ({ payload }) => {
      faceController.setState(payload.active ? "transcribing" : "thinking");
    }),
    interactionEventBus.on("voice.speaking", ({ payload }) => {
      faceController.setState(payload.active ? "speaking" : "idle");
    }),
    interactionEventBus.on("auth.started", () => faceController.setState("authenticating", 0.8)),
    interactionEventBus.on("auth.failed", () => {
      faceController.setState("error", 0.55);
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        if (faceController.getState() === "error") faceController.setState("idle");
      }, 1_800);
    }),
    interactionEventBus.on("clap.double_detected", () => {
      faceController.setSignals({ intensity: 1 });
    }),
    interactionEventBus.on("clap.activation_detected", () => {
      faceController.setSignals({ intensity: 1 });
    }),
    interactionEventBus.on("face.renderer_status", ({ payload }) => {
      if (payload.status === "lost") faceController.setState("offline");
      if (payload.status === "error") faceController.setState("error");
      if (payload.status === "restored") faceController.setState("idle");
    }),
  ];

  scene.setState(faceController.getState());
  return () => {
    if (gestureTimer) clearTimeout(gestureTimer);
    if (errorTimer) clearTimeout(errorTimer);
    for (const off of unsubscribe) off();
  };
}
