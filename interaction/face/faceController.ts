import { interactionEventBus } from "../events";
import { clampFaceSignal, type FaceState } from "../../lib/faceState";

let currentState: FaceState = "idle";

/** The single state-writing boundary for every Ultron interaction adapter. */
export const faceController = {
  getState(): FaceState {
    return currentState;
  },

  setState(state: FaceState, intensity?: number): void {
    const previous = currentState;
    currentState = state;
    interactionEventBus.emit({
      type: "face.state_changed",
      timestamp: Date.now(),
      payload: {
        previous,
        state,
        ...(intensity === undefined ? {} : { intensity: clampFaceSignal(intensity) }),
      },
    });
  },

  setSignals(signals: {
    audioLevel?: number;
    gestureEnergy?: number;
    intensity?: number;
  }): void {
    interactionEventBus.emit({
      type: "face.signals_changed",
      timestamp: Date.now(),
      payload: {
        ...(signals.audioLevel === undefined
          ? {}
          : { audioLevel: clampFaceSignal(signals.audioLevel) }),
        ...(signals.gestureEnergy === undefined
          ? {}
          : { gestureEnergy: clampFaceSignal(signals.gestureEnergy) }),
        ...(signals.intensity === undefined
          ? {}
          : { intensity: clampFaceSignal(signals.intensity) }),
      },
    });
  },
};
