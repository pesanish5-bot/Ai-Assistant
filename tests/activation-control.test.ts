import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readActivationEnabled, writeActivationEnabled } from "../core/activationControl.ts";

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
