import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UltronConfig } from "../core/config.ts";
import { openConversation } from "../core/conversationStore.ts";
import { MemoryLogger } from "../core/observability.ts";
import { MemoryPermissionGrantStore, PermissionService } from "../core/permissions.ts";
import { UltronRuntime } from "../core/runtime.ts";
import { calendarDate, MarkdownVault } from "../core/vault.ts";

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

test("chat commands can create the task, project, and inbox records plan and inbox read", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-runtime-records-"));
  try {
    const config: UltronConfig = {
      dataDir: directory,
      vaultDir: path.join(directory, "vault"),
      timezone: "Asia/Kolkata",
      github: { repositories: [] },
    };
    const vault = new MarkdownVault(config.vaultDir, { timezone: config.timezone });
    const runtime = new UltronRuntime({
      config,
      vault,
      permissions: new PermissionService(new MemoryPermissionGrantStore()),
      logger: new MemoryLogger(),
    });

    assert.equal((await runtime.execute({ message: "Add task Finish the voice setup due tomorrow" })).status, "ok");
    assert.equal((await runtime.execute({ message: "Add project Ultron: Make the morning brief useful" })).status, "ok");
    assert.equal((await runtime.execute({ message: "Add inbox Review the college notice" })).status, "ok");
    const today = calendarDate(new Date(), "Asia/Kolkata");
    const [year, month, day] = today.split("-").map(Number);
    const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
    assert.equal((await vault.search({ kind: "task" }))[0]?.data.dueAt, tomorrow);
    assert.equal((await runtime.execute({ message: "Done task Finish the voice setup" })).status, "ok");
    assert.equal((await vault.search({ kind: "task" }))[0]?.data.status, "done");
    assert.equal((await runtime.execute({ message: "Block project Ultron: waiting on calendar" })).status, "ok");
    assert.equal((await vault.search({ kind: "project" }))[0]?.data.blocker, "waiting on calendar");
    assert.equal((await vault.search({ kind: "project" })).length, 1);
    assert.equal((await vault.search({ kind: "inbox_item" })).length, 1);

    const plan = await runtime.execute({ message: "Plan my day" });
    assert.equal(plan.status, "ok");
    if (plan.status === "ok") {
      const data = plan.output.data as { priorities: Array<{ outcome: string }> };
      assert.ok(data.priorities.some((item) => item.outcome.includes("morning brief")));
    }
    const inbox = await runtime.execute({ message: "What needs me today?" });
    assert.equal(inbox.status, "ok");
    if (inbox.status === "ok") {
      const data = inbox.output.data as { items: unknown[] };
      assert.equal(data.items.length, 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitHub activity feeds trends and inbox after one remembered approval", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-runtime-activity-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/commits?")) {
        return new Response(JSON.stringify([{ sha: "abc123def456", html_url: "https://github.com/example/project/commit/abc", commit: { message: "Ship the voice host", author: { date: "2026-09-30T00:00:00Z" } } }]), { status: 200 });
      }
      if (url.includes("/issues?")) {
        return new Response(JSON.stringify([{ number: 7, title: "Review the HUD", html_url: "https://github.com/example/project/issues/7", updated_at: "2026-09-30T00:00:00Z" }]), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };
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
    const first = await runtime.execute({ message: "What's changed since yesterday?" });
    assert.equal(first.status, "confirmation_required");
    if (first.status !== "confirmation_required") return;
    const confirmed = await runtime.execute({ message: "What's changed since yesterday?", confirmationId: first.confirmation.id, rememberPermission: true });
    assert.equal(confirmed.status, "ok");
    if (confirmed.status === "ok") assert.match(confirmed.human, /Ship the voice host/);
    const inbox = await runtime.execute({ message: "What needs me today?" });
    assert.equal(inbox.status, "ok");
    if (inbox.status === "ok") assert.match(inbox.human, /Review the HUD/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a restarted runtime keeps the recent conversation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-runtime-memory-"));
  try {
    const config: UltronConfig = {
      dataDir: directory,
      vaultDir: path.join(directory, "vault"),
      timezone: "UTC",
      github: { repositories: [] },
    };
    const first = new UltronRuntime({
      config,
      vault: new MarkdownVault(config.vaultDir),
      permissions: new PermissionService(new MemoryPermissionGrantStore()),
      logger: new MemoryLogger(),
    });
    await first.execute({ message: "Remember that the desk lamp is warm" });
    const second = new UltronRuntime({
      config,
      vault: new MarkdownVault(config.vaultDir),
      permissions: new PermissionService(new MemoryPermissionGrantStore()),
      logger: new MemoryLogger(),
    });
    assert.match(second.conversation.snapshot("local").messages.map((message) => message.text).join("\n"), /desk lamp/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired conversation text is removed from local state when reopened", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-runtime-expired-"));
  const stateFile = path.join(directory, "state", "conversations.json");
  try {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({
      version: 1,
      sessions: {
        old: { updatedAt: Date.now() - 25 * 60 * 60_000, messages: [{ id: "old", role: "user", text: "expired private text", source: "voice", timestamp: new Date().toISOString(), cloudEligible: false }] },
        recent: { updatedAt: Date.now(), messages: [{ id: "new", role: "user", text: "recent private text", source: "text", timestamp: new Date().toISOString(), cloudEligible: false }] },
      },
    }));
    const memory = openConversation(directory);
    assert.deepEqual(memory.snapshot("old").messages, []);
    assert.equal(memory.snapshot("recent").messages[0]?.text, "recent private text");
    const persisted = await readFile(stateFile, "utf8");
    assert.doesNotMatch(persisted, /expired private text/);
    assert.match(persisted, /recent private text/);
    memory.add("recent", "assistant", "second reply", "text");
    assert.match(await readFile(stateFile, "utf8"), /second reply/);
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
      message: "How are things performing?",
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
