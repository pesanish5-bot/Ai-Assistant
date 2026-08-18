import assert from "node:assert/strict";
import test from "node:test";
import { createInboxSkill } from "../core/skills/inboxSkill.ts";
import { createMetricsSkill } from "../core/skills/metricsSkill.ts";
import { createPlanSkill } from "../core/skills/planSkill.ts";
import { SkillRegistry } from "../core/skills/registry.ts";
import { IntentRouter } from "../core/skills/router.ts";
import { createTrendsSkill } from "../core/skills/trendsSkill.ts";
import { createVaultSkill } from "../core/skills/vaultSkill.ts";

function createRouter() {
  const registry = new SkillRegistry();
  registry.register(createVaultSkill());
  registry.register(createInboxSkill());
  registry.register(createMetricsSkill());
  registry.register(createTrendsSkill());
  registry.register(createPlanSkill());
  const router = new IntentRouter(registry);
  router.registerWorkflow("morning", [{ phrases: ["good morning", "start my day"], weight: 15 }], 5);
  return { registry, router };
}

test("natural language routes deterministically to focused skills", () => {
  const { router } = createRouter();
  const cases = [
    ["What needs me today?", "skill", "inbox"],
    ["How are things performing?", "skill", "metrics"],
    ["What's changed since yesterday?", "skill", "trends"],
    ["What should I work on?", "skill", "plan"],
    ["Remember that Brave is my browser", "skill", "vault"],
    ["Update entry 8dc0ed77-4c68-4cbd-a377-0c059792b76e to changed context", "skill", "vault"],
    ["Good morning", "workflow", "morning"],
  ] as const;

  for (const [message, type, id] of cases) {
    const decision = router.route(message);
    assert.ok(decision, `Expected a route for: ${message}`);
    assert.deepEqual(decision.target, { type, id });
  }
  assert.equal(router.route("compose a symphony"), null);
});

test("skill registry rejects malformed and duplicate definitions", () => {
  const { registry } = createRouter();
  assert.throws(() => registry.register({ ...createVaultSkill(), id: "Bad Skill" }), /Malformed skill id/);
  assert.throws(() => registry.register(createVaultSkill()), /already registered/);
});
