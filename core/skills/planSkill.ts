import type { VaultEntry } from "../vault.ts";
import { renderSections, type SkillDefinition, type SkillExecutionContext, type SkillResult } from "./types.ts";

export interface DailyPriority {
  id: string;
  outcome: string;
  reason: string;
  source: string;
  score: number;
  dueAt?: string;
}

export interface PlanSkillData {
  date: string;
  priorities: DailyPriority[];
  planEntryId?: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown, fallback = 3): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function dateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function deadlineScore(dueAt: string | undefined, now: Date): number {
  if (!dueAt) return 0;
  const days = (Date.parse(dueAt) - now.getTime()) / 86_400_000;
  if (days <= 0) return 20;
  if (days <= 1) return 16;
  if (days <= 3) return 10;
  if (days <= 7) return 5;
  return 0;
}

function fromTask(entry: VaultEntry, context: SkillExecutionContext): DailyPriority | null {
  if (stringValue(entry.data.status)?.toLowerCase() === "done") return null;
  const outcome = stringValue(entry.data.outcome) ?? entry.title;
  if (!outcome) return null;
  const priority = Math.max(1, Math.min(5, numberValue(entry.data.priority)));
  const dueAt = stringValue(entry.data.dueAt);
  return {
    id: entry.id,
    outcome,
    reason: stringValue(entry.data.reason) ?? (entry.content || "This task is still unfinished."),
    source: "task",
    score: (6 - priority) * 3 + deadlineScore(dueAt, context.now),
    ...(dueAt ? { dueAt } : {}),
  };
}

function fromProject(entry: VaultEntry, context: SkillExecutionContext): DailyPriority | null {
  const status = stringValue(entry.data.status)?.toLowerCase();
  if (status === "complete" || status === "archived") return null;
  const outcome = stringValue(entry.data.currentGoal);
  if (!outcome) return null;
  const priority = Math.max(1, Math.min(5, numberValue(entry.data.priority)));
  const dueAt = stringValue(entry.data.deadline);
  return {
    id: entry.id,
    outcome,
    reason: `${entry.title} is an active priority.`,
    source: "project",
    score: (6 - priority) * 4 + deadlineScore(dueAt, context.now),
    ...(dueAt ? { dueAt } : {}),
  };
}

function priorData(context: SkillExecutionContext, skill: string): Record<string, unknown> {
  const data = context.priorResults.get(skill)?.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function contextualCandidates(context: SkillExecutionContext): DailyPriority[] {
  const candidates: DailyPriority[] = [];
  const inboxItems = priorData(context, "inbox").items;
  if (Array.isArray(inboxItems)) {
    inboxItems.forEach((value, index) => {
      if (!value || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      const outcome = stringValue(item.recommendedAction) ?? stringValue(item.summary);
      if (!outcome) return;
      candidates.push({
        id: stringValue(item.id) ?? `inbox-${index}`,
        outcome,
        reason: stringValue(item.reason) ?? "This item needs attention today.",
        source: "inbox",
        score: 24 - Math.max(1, Math.min(5, numberValue(item.priority))) * 2,
        ...(stringValue(item.dueAt) ? { dueAt: stringValue(item.dueAt) } : {}),
      });
    });
  }

  for (const skill of ["metrics", "trends"]) {
    const attention = priorData(context, skill).attention;
    if (!Array.isArray(attention)) continue;
    attention.forEach((value, index) => {
      if (typeof value !== "string" || !value.trim()) return;
      candidates.push({
        id: `${skill}-${index}-${value.slice(0, 24)}`,
        outcome: skill === "metrics" ? `Resolve metric concern: ${value}` : `Assess trend impact: ${value}`,
        reason: `The ${skill} skill marked this for attention.`,
        source: skill,
        score: skill === "metrics" ? 17 : 13,
      });
    });
  }

  return candidates;
}

function uniqueTopThree(candidates: DailyPriority[]): DailyPriority[] {
  const seen = new Set<string>();
  return candidates
    .sort((left, right) => right.score - left.score || left.outcome.localeCompare(right.outcome))
    .filter((candidate) => {
      const key = candidate.outcome.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

export function createPlanSkill(): SkillDefinition<PlanSkillData> {
  return {
    id: "plan",
    name: "Plan",
    description: "Turn current context into the three highest-priority outcomes for today.",
    priority: 2,
    routes: [
      { phrases: ["plan my day", "make today's plan", "what are my priorities", "what should i work on", "what should i do today"], weight: 12 },
      { phrases: ["what should i do next", "priorities", "today's plan", "daily plan"], weight: 8 },
    ],
    async execute(context): Promise<SkillResult<PlanSkillData>> {
      const [tasks, projects] = await Promise.all([
        context.vault.search({ namespace: "knowledge", kind: "task", limit: 100 }),
        context.vault.search({ namespace: "knowledge", kind: "project", limit: 50 }),
      ]);
      const candidates = [
        ...tasks.map((entry) => fromTask(entry, context)).filter((item): item is DailyPriority => item !== null),
        ...projects.map((entry) => fromProject(entry, context)).filter((item): item is DailyPriority => item !== null),
        ...contextualCandidates(context),
      ];
      const priorities = uniqueTopThree(candidates);
      const date = dateInTimezone(context.now, context.config.timezone);
      const warnings: string[] = [];
      if (priorities.length < 3) {
        warnings.push(`Only ${priorities.length} grounded priorit${priorities.length === 1 ? "y was" : "ies were"} available; Ultron did not invent filler work.`);
      }

      const planData = { date, priorities };
      const data: PlanSkillData = {
        date,
        priorities,
      };
      const result: SkillResult<PlanSkillData> = {
        skill: "plan",
        timestamp: context.now.toISOString(),
        summary: priorities.length
          ? `Your ${priorities.length} highest-priority outcome${priorities.length === 1 ? "" : "s"} for today.`
          : "There is not enough grounded project or task context to create today's plan yet.",
        sections: [
          {
            title: "Today",
            items: priorities.map((item, index) => `${index + 1}. ${item.outcome} — ${item.reason}`),
          },
        ],
        data,
        warnings,
      };
      const output = await context.vault.writeOutput({
        kind: "daily_plan",
        type: "daily-plan",
        topic: "daily-plan",
        title: `Daily plan ${date}`,
        summary: priorities.length
          ? `The ${priorities.length} highest-priority outcomes for ${date}.`
          : `No grounded priorities were available for ${date}.`,
        content: renderSections(result.summary, result.sections),
        tags: ["plan", date],
        data: planData,
        wikilinks: ["current-projects"],
      });
      result.data.planEntryId = output.id;
      return result;
    },
  };
}
