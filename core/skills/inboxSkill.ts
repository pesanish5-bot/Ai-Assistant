import type { VaultEntry } from "../vault.ts";
import { renderSections, type SkillDefinition, type SkillExecutionContext, type SkillResult } from "./types.ts";

export interface InboxItem {
  id: string;
  priority: number;
  source: string;
  summary: string;
  reason: string;
  recommendedAction: string;
  dueAt?: string;
}

interface InboxSkillData {
  items: InboxItem[];
  configuredSources: string[];
  unavailableSources: string[];
  outputId?: string;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function toInboxItem(entry: VaultEntry): InboxItem {
  const priorityValue = typeof entry.data.priority === "number" ? entry.data.priority : 3;
  const dueAt = typeof entry.data.dueAt === "string" ? entry.data.dueAt : undefined;
  return {
    id: entry.id,
    priority: Math.max(1, Math.min(5, priorityValue)),
    source: text(entry.data.source, "manual"),
    summary: text(entry.data.summary, entry.title),
    reason: text(entry.data.reason, entry.content || "This item was marked for attention."),
    recommendedAction: text(entry.data.recommendedAction, "Review and decide the next action."),
    ...(dueAt ? { dueAt } : {}),
  };
}

function urgency(item: InboxItem): number {
  if (!item.dueAt) return 0;
  const hours = (Date.parse(item.dueAt) - Date.now()) / 3_600_000;
  if (hours <= 0) return 5;
  if (hours <= 24) return 4;
  if (hours <= 72) return 2;
  return 0;
}

export function createInboxSkill(): SkillDefinition<InboxSkillData> {
  return {
    id: "inbox",
    name: "Inbox",
    description: "Produce the three items that most need the user today.",
    priority: 2,
    routes: [
      { phrases: ["what needs me today", "what needs my attention", "anything urgent", "what's on my plate"], weight: 12 },
      { phrases: ["check my inbox", "inbox", "meetings", "college notices", "morning brief"], weight: 8 },
    ],
    async execute(context): Promise<SkillResult<InboxSkillData>> {
      const entries = await context.vault.search({ namespace: "knowledge", kind: "inbox_item", limit: 50 });
      const items = entries
        .map(toInboxItem)
        .sort((left, right) => left.priority - right.priority || urgency(right) - urgency(left))
        .slice(0, 3);
      const unavailableSources = ["Gmail", "Outlook", "WhatsApp", "Google Calendar"];
      const warnings = [
        "Gmail, Outlook, WhatsApp, and Google Calendar connectors are not configured yet; only Vault inbox items are included.",
      ];

      const data: InboxSkillData = { items, configuredSources: ["Vault"], unavailableSources };
      const result: SkillResult<InboxSkillData> = {
        skill: "inbox",
        timestamp: context.now.toISOString(),
        summary: items.length
          ? `These are the ${items.length} things that most need you today.`
          : "No actionable inbox items are available yet.",
        sections: items.map((item, index) => ({
          title: `${index + 1}. ${item.summary}`,
          items: [`Why: ${item.reason}`, `Next: ${item.recommendedAction}`],
        })),
        data: { ...data },
        warnings,
      };
      const output = await context.vault.writeOutput({
        kind: "inbox_brief",
        type: "inbox-brief",
        topic: "inbox-brief",
        title: `Inbox brief ${context.now.toISOString().slice(0, 10)}`,
        summary: items.length
          ? `The ${items.length} operational items that most need attention.`
          : "No actionable inbox items were available during this scan.",
        content: renderSections(result.summary, result.sections),
        tags: ["inbox", "brief"],
        data: { ...data },
      });
      result.data.outputId = output.id;
      return result;
    },
  };
}
