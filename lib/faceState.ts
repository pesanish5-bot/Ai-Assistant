export const FACE_STATES = [
  "idle",
  "listening",
  "transcribing",
  "thinking",
  "working",
  "speaking",
  "gesture_active",
  "authenticating",
  "error",
  "offline",
] as const;

export type FaceState = (typeof FACE_STATES)[number];

export interface FaceSignals {
  state: FaceState;
  audioLevel: number;
  gestureEnergy: number;
  intensity: number;
}

export interface FaceVisualProfile {
  rotationMultiplier: number;
  bloomStrength: number;
  pulseAmplitude: number;
  exposure: number;
  chromaticIntensity: number;
  shellScale: number;
  signalEnergy: number;
}

type BaseVisualProfile = Omit<FaceVisualProfile, "signalEnergy">;

const BASE_PROFILES: Record<FaceState, BaseVisualProfile> = {
  idle: {
    rotationMultiplier: 1,
    bloomStrength: 1.6,
    pulseAmplitude: 1,
    exposure: 0.8,
    chromaticIntensity: 0.003,
    shellScale: 1,
  },
  listening: {
    rotationMultiplier: 0.88,
    bloomStrength: 1.82,
    pulseAmplitude: 1.12,
    exposure: 0.86,
    chromaticIntensity: 0.0024,
    shellScale: 1.008,
  },
  transcribing: {
    rotationMultiplier: 0.62,
    bloomStrength: 1.48,
    pulseAmplitude: 0.84,
    exposure: 0.74,
    chromaticIntensity: 0.0018,
    shellScale: 0.995,
  },
  thinking: {
    rotationMultiplier: 1.28,
    bloomStrength: 1.74,
    pulseAmplitude: 1.18,
    exposure: 0.82,
    chromaticIntensity: 0.0038,
    shellScale: 1.012,
  },
  working: {
    rotationMultiplier: 1.48,
    bloomStrength: 1.92,
    pulseAmplitude: 1.28,
    exposure: 0.88,
    chromaticIntensity: 0.0042,
    shellScale: 1.018,
  },
  speaking: {
    rotationMultiplier: 1.02,
    bloomStrength: 1.88,
    pulseAmplitude: 1.3,
    exposure: 0.9,
    chromaticIntensity: 0.0028,
    shellScale: 1.01,
  },
  gesture_active: {
    rotationMultiplier: 1.38,
    bloomStrength: 1.98,
    pulseAmplitude: 1.2,
    exposure: 0.88,
    chromaticIntensity: 0.0034,
    shellScale: 1.016,
  },
  authenticating: {
    rotationMultiplier: 0.54,
    bloomStrength: 1.68,
    pulseAmplitude: 0.94,
    exposure: 0.78,
    chromaticIntensity: 0.0012,
    shellScale: 0.985,
  },
  error: {
    rotationMultiplier: 0.3,
    bloomStrength: 1.06,
    pulseAmplitude: 0.52,
    exposure: 0.58,
    chromaticIntensity: 0.0065,
    shellScale: 0.972,
  },
  offline: {
    rotationMultiplier: 0.06,
    bloomStrength: 0.32,
    pulseAmplitude: 0.12,
    exposure: 0.24,
    chromaticIntensity: 0.0004,
    shellScale: 0.95,
  },
};

export function clampFaceSignal(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Smooth a transient signal back toward the normal idle baseline. */
export function decayFaceSignal(value: number, baseline = 0.5, rate = 0.035): number {
  const current = clampFaceSignal(value);
  const target = clampFaceSignal(baseline);
  return current + (target - current) * clampFaceSignal(rate);
}

export function isFaceState(value: unknown): value is FaceState {
  return typeof value === "string" && (FACE_STATES as readonly string[]).includes(value);
}

export function resolveFaceVisualProfile(signals: FaceSignals): FaceVisualProfile {
  const base = BASE_PROFILES[signals.state];
  const audioLevel = clampFaceSignal(signals.audioLevel);
  const gestureEnergy = clampFaceSignal(signals.gestureEnergy);
  const intensity = clampFaceSignal(signals.intensity);
  const signalEnergy = Math.min(1, audioLevel * 0.82 + gestureEnergy * 0.68);
  const intensityScale = 0.82 + intensity * 0.36;

  return {
    rotationMultiplier: base.rotationMultiplier * (1 + gestureEnergy * 0.16),
    bloomStrength: base.bloomStrength * intensityScale + signalEnergy * 0.2,
    pulseAmplitude: base.pulseAmplitude * (0.9 + intensity * 0.2) + signalEnergy * 0.3,
    exposure: base.exposure * (0.88 + intensity * 0.24) + signalEnergy * 0.04,
    chromaticIntensity: base.chromaticIntensity + gestureEnergy * 0.0005,
    shellScale: base.shellScale + signalEnergy * 0.012,
    signalEnergy,
  };
}
