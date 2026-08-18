import assert from "node:assert/strict";
import test from "node:test";
import {
  FACE_STATES,
  clampFaceSignal,
  decayFaceSignal,
  isFaceState,
  resolveFaceVisualProfile,
} from "../lib/faceState.ts";

test("face states resolve to finite restrained visual profiles", () => {
  for (const state of FACE_STATES) {
    const profile = resolveFaceVisualProfile({
      state,
      audioLevel: 0.5,
      gestureEnergy: 0.5,
      intensity: 0.5,
    });

    for (const value of Object.values(profile)) assert.equal(Number.isFinite(value), true);
    assert.ok(profile.rotationMultiplier >= 0 && profile.rotationMultiplier < 2);
    assert.ok(profile.bloomStrength >= 0 && profile.bloomStrength < 3);
    assert.ok(profile.exposure >= 0 && profile.exposure < 2);
    assert.ok(profile.shellScale >= 0.9 && profile.shellScale < 1.1);
  }
});

test("transient face intensity decays toward the idle baseline", () => {
  const fromBright = decayFaceSignal(1);
  const fromDim = decayFaceSignal(0);
  assert.ok(fromBright < 1 && fromBright > 0.5);
  assert.ok(fromDim > 0 && fromDim < 0.5);
});

test("face signals are clamped and validated", () => {
  assert.equal(clampFaceSignal(-2), 0);
  assert.equal(clampFaceSignal(4), 1);
  assert.equal(clampFaceSignal(Number.NaN), 0);
  assert.equal(isFaceState("authenticating"), true);
  assert.equal(isFaceState("unknown"), false);

  const quiet = resolveFaceVisualProfile({
    state: "speaking",
    audioLevel: 0,
    gestureEnergy: 0,
    intensity: 0.5,
  });
  const active = resolveFaceVisualProfile({
    state: "speaking",
    audioLevel: 3,
    gestureEnergy: 3,
    intensity: 3,
  });

  assert.ok(active.signalEnergy > quiet.signalEnergy);
  assert.ok(active.bloomStrength > quiet.bloomStrength);
  assert.ok(active.shellScale > quiet.shellScale);
});
