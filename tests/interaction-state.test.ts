import assert from "node:assert/strict";
import test from "node:test";
import {
  InteractionStateProjector,
  isAuthorizedInteractionToken,
  parseSafeBridgeEvent,
} from "../core/interactionState.ts";

test("interaction bridge accepts only coarse non-biometric HUD events", () => {
  const projector = new InteractionStateProjector();
  const first = projector.apply({
    name: "voice.listening",
    timestamp: 10,
    payload: { active: true },
  });
  assert.equal(first.sequence, 1);
  assert.equal(typeof first.generation, "string");
  assert.equal(first.event?.name, "voice.listening");

  projector.apply({ name: "voice.listening", timestamp: 11, payload: { active: false } });
  const delta = projector.snapshot(0);
  assert.equal(delta.sequence, 2);
  assert.deepEqual(delta.events?.map((event) => event.payload.active), [true, false]);

  assert.throws(
    () => parseSafeBridgeEvent({ name: "auth.speaker_verified", timestamp: 12, payload: {} }),
    /not permitted/,
  );
  assert.throws(
    () =>
      parseSafeBridgeEvent({
        name: "auth.failed",
        timestamp: 12,
        payload: { speaker_similarity: 0.99 },
      }),
    /field is not permitted/,
  );
  assert.throws(
    () => parseSafeBridgeEvent({ name: "voice.listening", timestamp: 12, payload: { transcript: "secret" } }),
    /field is not permitted/,
  );
});

test("a restarted interaction projector has a new generation for warm HUD clients", () => {
  const originalProjector = new InteractionStateProjector();
  originalProjector.apply({ name: "voice.listening", timestamp: 1, payload: { active: true } });
  originalProjector.apply({ name: "voice.listening", timestamp: 2, payload: { active: false } });
  const first = originalProjector.snapshot();
  const restartedProjector = new InteractionStateProjector();
  restartedProjector.apply({ name: "voice.speaking", timestamp: 3, payload: { active: true } });
  const restarted = restartedProjector.snapshot(20, first.generation);
  assert.notEqual(first.generation, restarted.generation);
  assert.equal(restarted.sequence, 1);
  assert.deepEqual(restarted.events?.map((event) => event.name), ["voice.speaking"]);
});

test("interaction bridge requires an exact high-entropy token", () => {
  const token = "a".repeat(32);
  assert.equal(isAuthorizedInteractionToken(token, token), true);
  assert.equal(isAuthorizedInteractionToken("a".repeat(31), token), false);
  // Same JavaScript code-unit length as the expected token, but a different
  // UTF-8 byte length. This must reject without timingSafeEqual throwing.
  assert.equal(isAuthorizedInteractionToken("\u00e9".repeat(32), token), false);
  assert.equal(isAuthorizedInteractionToken(token, undefined), false);
});
