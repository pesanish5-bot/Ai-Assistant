import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryLogger } from "../core/observability.ts";
import { MemoryPermissionGrantStore, PermissionService } from "../core/permissions.ts";
import { UltronRuntime } from "../core/runtime.ts";
import { createTimeSkill } from "../core/skills/timeSkill.ts";

test("time skill uses the configured timezone and an injected clock value", async () => {
  const skill = createTimeSkill();
  const now = new Date("2026-01-01T00:00:00.000Z");
  const result = await skill.execute({
    message: "What time is it?", requestId: "clock-test", now,
    config: { dataDir: ".ultron", vaultDir: ".ultron/vault", timezone: "Asia/Kolkata", github: { repositories: [] } },
    vault: {} as never, tools: {} as never, logger: new MemoryLogger(), priorResults: new Map(),
  });
  assert.equal(result.skill, "time");
  assert.equal(result.data.timezone, "Asia/Kolkata");
  assert.match(result.summary, /5:30\s*am/i);
  assert.equal(result.data.isoTimestamp, now.toISOString());
});

test("ordinary time question routes locally without an LLM key", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-time-test-"));
  try {
    const runtime = new UltronRuntime({
      config: { dataDir: directory, vaultDir: path.join(directory, "vault"), timezone: "Asia/Kolkata", github: { repositories: [] } },
      permissions: new PermissionService(new MemoryPermissionGrantStore()),
      logger: new MemoryLogger(),
    });
    const response = await runtime.execute({ message: "What time is it?" });
    assert.equal(response.status, "ok");
    if (response.status === "ok") {
      assert.equal(response.output.skill, "time");
      assert.equal((response.output.data as { timezone: string }).timezone, "Asia/Kolkata");
      assert.match(response.human, /^It's /);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
