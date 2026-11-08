import assert from "node:assert/strict";
import test from "node:test";
import { RequestLimiter } from "../core/requestLimit.ts";

test("local request limiter enforces the shortest exhausted window", () => {
  let now = 1_000;
  const limiter = new RequestLimiter(
    [
      { windowMs: 1_000, max: 2 },
      { windowMs: 10_000, max: 5 },
    ],
    () => now,
  );

  assert.equal(limiter.tryAcquire().ok, true);
  assert.equal(limiter.tryAcquire().ok, true);
  const blocked = limiter.tryAcquire();
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1_000);

  now += 1_000;
  assert.equal(limiter.tryAcquire().ok, true);
});
