import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UltronConfig } from "../core/config.ts";
import { MemoryLogger } from "../core/observability.ts";
import { MemoryPermissionGrantStore, PermissionService } from "../core/permissions.ts";
import { UltronRuntime } from "../core/runtime.ts";
import { MarkdownVault } from "../core/vault.ts";

test("initial skills route, cooperate, persist, and degrade gracefully", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-runtime-test-"));
  try {
    const config: UltronConfig = {
      dataDir: directory,
      vaultDir: path.join(directory, "vault"),
      timezone: "UTC",
      github: { repositories: [] },
    };
    const vault = new MarkdownVault(config.vaultDir);
    await vault.initialize();
    const runtime = new UltronRuntime({
      config,
      vault,
      permissions: new PermissionService(new MemoryPermissionGrantStore()),
      logger: new MemoryLogger(),
    });

    await vault.save({
      namespace: "knowledge",
      kind: "project",
      title: "AI Assistant",
      data: { priority: 1, status: "active", currentGoal: "Finish the personal AI OS foundation." },
    });
    await vault.save({
      namespace: "knowledge",
      kind: "project",
      title: "Beauty parlour website",
      data: { priority: 2, status: "active", currentGoal: "Define the client website scope." },
    });
    await vault.save({
      namespace: "knowledge",
      kind: "task",
      title: "College work",
      data: { priority: 3, status: "open", outcome: "Complete the next college deliverable." },
    });
    await vault.save({
      namespace: "knowledge",
      kind: "inbox_item",
      title: "College notice",
      data: {
        priority: 1,
        source: "manual",
        summary: "Review a new college notice",
        reason: "It may affect the schedule.",
        recommendedAction: "Read the notice and record any deadline.",
      },
    });
    await vault.save({
      namespace: "knowledge",
      kind: "metric_snapshot",
      title: "Manual metrics",
      data: { points: [{ name: "Gym sessions", value: 4, unit: "this week", source: "manual" }] },
    });
    await vault.save({
      namespace: "knowledge",
      kind: "trend_snapshot",
      title: "Previous trends",
      data: { items: [{ id: "ai-agents", title: "AI agents", summary: "Early adoption", tags: ["ai"] }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await vault.save({
      namespace: "knowledge",
      kind: "trend_snapshot",
      title: "Current trends",
      data: {
        items: [
          { id: "ai-agents", title: "AI agents", summary: "Tool use is expanding", tags: ["ai"] },
          { id: "coding-agents", title: "Coding agents", summary: "Local workflows are improving", tags: ["ai"] },
        ],
      },
    });

    const plan = await runtime.execute({ message: "Plan my day" });
    assert.equal(plan.status, "ok");
    if (plan.status === "ok") {
      const data = plan.output.data as { priorities: unknown[] };
      assert.equal(data.priorities.length, 3);
    }

    const inbox = await runtime.execute({ message: "What needs me today?" });
    assert.equal(inbox.status, "ok");
    const trends = await runtime.execute({ message: "What changed since yesterday?" });
    assert.equal(trends.status, "ok");

    const morning = await runtime.execute({ message: "Good morning" });
    assert.equal(morning.status, "ok");
    assert.ok((await vault.search({ kind: "daily_plan" })).length >= 1);
    assert.equal((await vault.search({ kind: "briefing" })).length, 1);
    assert.ok((await vault.search({ kind: "inbox_brief", layer: "outputs" })).length >= 2);
    assert.ok((await vault.search({ kind: "metric_snapshot", layer: "outputs" })).length >= 1);
    assert.ok((await vault.search({ kind: "trend_report", layer: "outputs" })).length >= 2);
    assert.deepEqual(await vault.validateAll(), []);

    const remember = await runtime.execute({ message: "Remember that Brave is my preferred browser" });
    assert.equal(remember.status, "ok");
    const remembered = await vault.search({ namespace: "memory", text: "Brave" });
    assert.equal(remembered.length, 1);
    const update = await runtime.execute({
      message: `Update entry ${remembered[0].id} to Brave is my default browser`,
    });
    assert.equal(update.status, "ok");
    assert.equal((await vault.search({ namespace: "memory", text: "default browser" })).length, 1);
    const forget = await runtime.execute({ message: `Forget entry ${remembered[0].id}` });
    assert.equal(forget.status, "ok");
    assert.equal(await vault.get(remembered[0].id), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime cannot apply a read confirmation to a different natural-language request", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-runtime-permission-test-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          full_name: "example/project",
          default_branch: "main",
          stargazers_count: 1,
          forks_count: 2,
          open_issues_count: 3,
          archived: false,
          pushed_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-01T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const config: UltronConfig = {
      dataDir: directory,
      vaultDir: path.join(directory, "vault"),
      timezone: "UTC",
      github: { repositories: ["example/project"] },
    };
    const runtime = new UltronRuntime({
      config,
      vault: new MarkdownVault(config.vaultDir),
      permissions: new PermissionService(new MemoryPermissionGrantStore()),
      logger: new MemoryLogger(),
    });

    const first = await runtime.execute({ message: "Give me the numbers" });
    assert.equal(first.status, "confirmation_required");
    assert.equal("confirmation" in first, true);
    if (first.status !== "confirmation_required") return;

    const mismatch = await runtime.execute({
      message: "Show me today's metrics",
      confirmationId: first.confirmation.id,
    });
    assert.equal(mismatch.status, "error");

    const second = await runtime.execute({ message: "Give me the numbers" });
    assert.equal(second.status, "confirmation_required");
    if (second.status !== "confirmation_required") return;
    const confirmed = await runtime.execute({
      message: "Give me the numbers",
      confirmationId: second.confirmation.id,
    });
    assert.equal(confirmed.status, "ok");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
