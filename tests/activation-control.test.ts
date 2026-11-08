import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readActivationEnabled, writeActivationEnabled } from "../core/activationControl.ts";
import { isAuthorizedInteractionToken } from "../core/interactionState.ts";

test("background activation switch persists on/off and fails quiet on damaged state", () => {
  const directory = mkdtempSync(join(tmpdir(), "ultron-activation-"));
  const path = join(directory, "control.json");
  try {
    assert.equal(readActivationEnabled(path), true);
    writeActivationEnabled(false, path);
    assert.equal(readActivationEnabled(path), false);
    writeActivationEnabled(true, path);
    assert.equal(readActivationEnabled(path), true);
    writeFileSync(path, "invalid", "utf8");
    assert.equal(readActivationEnabled(path), false);
    assert.throws(() => writeActivationEnabled("off" as unknown as boolean, path));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("activation mutations accept the launcher event token and reject mismatches", () => {
  const token = "a".repeat(32);
  assert.equal(isAuthorizedInteractionToken(token, token), true);
  assert.equal(isAuthorizedInteractionToken("b".repeat(32), token), false);
  assert.equal(isAuthorizedInteractionToken(null, token), false);
  assert.equal(isAuthorizedInteractionToken(token, undefined), false);
});
