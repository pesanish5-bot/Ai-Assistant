import assert from "node:assert/strict";
import test from "node:test";
import { InteractionEventBus } from "../interaction/events.ts";
import { cameraReadiness } from "../interaction/gesture/cameraState.ts";
import {
  GestureController,
  classifyGestureMode,
  type HandGestureObservation,
} from "../interaction/gesture/gestureController.ts";

function hand(
  id: string,
  pinchRatio: number,
  x: number,
  y: number,
): HandGestureObservation {
  return { id, pinchRatio, grab: { x, y } };
}

function approximately(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `Expected ${actual} to be approximately ${expected}`,
  );
}

test("gesture classifier preserves the original idle, spin, and zoom vocabulary", () => {
  assert.equal(classifyGestureMode(0), "idle");
  assert.equal(classifyGestureMode(1), "spin");
  assert.equal(classifyGestureMode(2), "zoom");
  assert.equal(classifyGestureMode(3), "zoom");
});

test("one pinched hand emits only smoothed spin intent with hysteresis", () => {
  const controller = new GestureController();

  const first = controller.update([hand("Left", 0.2, 0.2, 0.2)]);
  assert.deepEqual(first.status, { hands: 1, mode: "spin" });
  assert.equal(first.intent, null, "entering spin mode must not jump the camera");

  const moved = controller.update([hand("Left", 0.4, 0.3, 0.1)]);
  assert.equal(moved.status.mode, "spin", "pinch remains active inside the hysteresis band");
  assert.equal(moved.intent?.kind, "spin");
  if (moved.intent?.kind !== "spin") assert.fail("Expected a spin intent");
  approximately(moved.intent.deltaTheta, 0.2);
  approximately(moved.intent.deltaPhi, -0.2);

  const released = controller.update([hand("Left", 0.46, 0.3, 0.1)]);
  assert.deepEqual(released.status, { hands: 1, mode: "idle" });
  assert.equal(released.intent, null);
});

test("two pinched hands emit bounded zoom intent for spread and close", () => {
  const controller = new GestureController();

  const first = controller.update([
    hand("Left", 0.2, 0.2, 0.5),
    hand("Right", 0.2, 0.8, 0.5),
  ]);
  assert.deepEqual(first.status, { hands: 2, mode: "zoom" });
  assert.equal(first.intent, null, "entering zoom mode must not jump the camera");

  const spread = controller.update([
    hand("Left", 0.2, 0.1, 0.5),
    hand("Right", 0.2, 0.9, 0.5),
  ]);
  assert.equal(spread.intent?.kind, "zoom");
  if (spread.intent?.kind !== "zoom") assert.fail("Expected a zoom intent");
  assert.ok(spread.intent.factor < 1, "spreading hands should zoom in");
  approximately(spread.intent.factor, 0.6 / 0.68);

  const close = controller.update([
    hand("Left", 0.2, 0.25, 0.5),
    hand("Right", 0.2, 0.75, 0.5),
  ]);
  assert.equal(close.intent?.kind, "zoom");
  if (close.intent?.kind !== "zoom") assert.fail("Expected a zoom intent");
  assert.ok(close.intent.factor > 1, "bringing hands together should zoom out");
  assert.ok(close.intent.factor <= 1.18);
});

test("interaction bus scopes listeners by type and supports on, off, and emit", () => {
  const bus = new InteractionEventBus();
  const gestures: string[] = [];
  const cameraStates: string[] = [];

  const gestureListener = (event: Parameters<typeof bus.emit>[0]) => {
    if (event.type === "gesture.detected") gestures.push(event.payload.gesture);
  };
  const cameraListener = (event: Parameters<typeof bus.emit>[0]) => {
    if (event.type === "camera.state_changed") cameraStates.push(event.payload.state);
  };

  const unsubscribeGesture = bus.on("gesture.detected", gestureListener);
  bus.on("camera.state_changed", cameraListener);

  bus.emit({
    type: "gesture.detected",
    timestamp: 1,
    payload: {
      source: "mediapipe",
      gesture: "spin",
      hands: 1,
      deltaTheta: 0.1,
      deltaPhi: -0.2,
    },
  });
  bus.emit({
    type: "camera.state_changed",
    timestamp: 2,
    payload: { state: "active" },
  });

  unsubscribeGesture();
  bus.off("camera.state_changed", cameraListener);
  bus.emit({
    type: "gesture.detected",
    timestamp: 3,
    payload: {
      source: "mediapipe",
      gesture: "zoom",
      hands: 2,
      factor: 0.9,
    },
  });
  bus.emit({
    type: "camera.state_changed",
    timestamp: 4,
    payload: { state: "disabled" },
  });

  assert.deepEqual(gestures, ["spin"]);
  assert.deepEqual(cameraStates, ["active"]);
});

test("camera readiness labels make privacy state explicit", () => {
  assert.deepEqual(cameraReadiness("disabled"), {
    camera: "DISABLED",
    gestures: "DISABLED",
  });
  assert.deepEqual(cameraReadiness("starting"), {
    camera: "STARTING",
    gestures: "INITIALIZING",
  });
  assert.deepEqual(cameraReadiness("active"), {
    camera: "ACTIVE",
    gestures: "READY",
  });
  assert.deepEqual(cameraReadiness("error"), {
    camera: "ERROR",
    gestures: "ERROR",
  });
});

test("one broken interaction listener does not block later listeners", () => {
  const errors: unknown[] = [];
  const bus = new InteractionEventBus((error) => errors.push(error));
  const delivered: string[] = [];
  bus.on("camera.state_changed", () => {
    throw new Error("broken listener");
  });
  bus.on("camera.state_changed", ({ payload }) => delivered.push(payload.state));
  bus.emit({
    type: "camera.state_changed",
    timestamp: 1,
    payload: { state: "active" },
  });
  assert.equal(errors.length, 1);
  assert.deepEqual(delivered, ["active"]);
});
