import type { RouteRule, SkillDefinition } from "./types.ts";
import type { SkillRegistry } from "./registry.ts";

export type RouteTarget =
  | { type: "skill"; id: string }
  | { type: "workflow"; id: string };

export interface RouteDecision {
  target: RouteTarget;
  score: number;
  matchedPhrase: string;
}

interface RouteDefinition {
  target: RouteTarget;
  priority: number;
  rules: RouteRule[];
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreDefinition(input: string, definition: RouteDefinition): RouteDecision | null {
  const paddedInput = ` ${input} `;
  let bestScore = 0;
  let matchedPhrase = "";

  for (const rule of definition.rules) {
    for (const rawPhrase of rule.phrases) {
      const phrase = normalize(rawPhrase);
      if (!phrase) continue;
      const exact = input === phrase;
      const included = paddedInput.includes(` ${phrase} `);
      if (!exact && !included) continue;

      const score = rule.weight + phrase.split(" ").length + (exact ? 12 : 0);
      if (score > bestScore) {
        bestScore = score;
        matchedPhrase = rawPhrase;
      }
    }
  }

  if (bestScore === 0) return null;
  return { target: definition.target, score: bestScore + definition.priority, matchedPhrase };
}

export class IntentRouter {
  private readonly definitions: RouteDefinition[] = [];

  constructor(registry: SkillRegistry) {
    for (const skill of registry.list()) this.addSkill(skill);
  }

  private addSkill(skill: SkillDefinition<unknown>): void {
    this.definitions.push({
      target: { type: "skill", id: skill.id },
      priority: skill.priority ?? 0,
      rules: skill.routes,
    });
  }

  registerWorkflow(id: string, rules: RouteRule[], priority = 0): void {
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || rules.length === 0) {
      throw new Error(`Malformed workflow route: ${id}`);
    }
    this.definitions.push({ target: { type: "workflow", id }, priority, rules });
  }

  route(message: string): RouteDecision | null {
    const normalized = normalize(message);
    if (!normalized) return null;

    return this.definitions
      .map((definition) => scoreDefinition(normalized, definition))
      .filter((decision): decision is RouteDecision => decision !== null)
      .sort(
        (left, right) =>
          right.score - left.score ||
          `${left.target.type}:${left.target.id}`.localeCompare(`${right.target.type}:${right.target.id}`),
      )[0] ?? null;
  }
}
