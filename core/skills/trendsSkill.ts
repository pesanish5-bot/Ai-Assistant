import type { VaultEntry } from "../vault.ts";
import { renderSections, type SkillDefinition, type SkillResult } from "./types.ts";

export interface TrendItem {
  id: string;
  title: string;
  summary: string;
  source?: string;
  tags: string[];
  attention?: string;
}

interface TrendsSkillData {
  meaningfulNew: TrendItem[];
  importantChanges: TrendItem[];
  emergingPatterns: string[];
  attention: string[];
  currentSnapshotId?: string;
  previousSnapshotId?: string;
  outputId?: string;
}

function parseItems(entry: VaultEntry | undefined): TrendItem[] {
  if (!entry || !Array.isArray(entry.data.items)) return [];
  return entry.data.items.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) return [];
    return [{
      id: typeof item.id === "string" ? item.id : `${title.toLowerCase().replace(/\s+/g, "-")}-${index}`,
      title,
      summary: typeof item.summary === "string" ? item.summary : "",
      ...(typeof item.source === "string" ? { source: item.source } : {}),
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [],
      ...(typeof item.attention === "string" ? { attention: item.attention } : {}),
    }];
  });
}

function findPatterns(items: TrendItem[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([tag, count]) => `${tag}: ${count} related developments`);
}

export function createTrendsSkill(): SkillDefinition<TrendsSkillData> {
  return {
    id: "trends",
    name: "Trends",
    description: "Compare trend snapshots and report meaningful deltas rather than a news dump.",
    priority: 2,
    routes: [
      { phrases: ["what changed since yesterday", "what's changed", "what is new", "what's new", "catch me up"], weight: 12 },
      { phrases: ["trends", "what's moving in ai", "anything important happening", "ai news", "technology news"], weight: 8 },
    ],
    async execute(context): Promise<SkillResult<TrendsSkillData>> {
      const snapshots = await context.vault.search({ namespace: "knowledge", kind: "trend_snapshot", limit: 2 });
      const current = snapshots[0];
      const previous = snapshots[1];
      const currentItems = parseItems(current);
      const previousById = new Map(parseItems(previous).map((item) => [item.id, item]));
      const meaningfulNew = currentItems.filter((item) => !previousById.has(item.id));
      const importantChanges = currentItems.filter((item) => {
        const before = previousById.get(item.id);
        return before !== undefined && before.summary !== item.summary;
      });
      const emergingPatterns = findPatterns([...meaningfulNew, ...importantChanges]);
      const attention = currentItems.flatMap((item) => (item.attention ? [item.attention] : []));
      const warnings: string[] = [];

      if (!current) warnings.push("No trend source is configured and no Vault trend snapshot exists yet.");
      else if (!previous) warnings.push("A previous trend snapshot is needed before a reliable delta can be calculated.");

      const data: TrendsSkillData = {
        meaningfulNew,
        importantChanges,
        emergingPatterns,
        attention,
        ...(current ? { currentSnapshotId: current.id } : {}),
        ...(previous ? { previousSnapshotId: previous.id } : {}),
      };

      const result: SkillResult<TrendsSkillData> = {
        skill: "trends",
        timestamp: context.now.toISOString(),
        summary: current
          ? `${meaningfulNew.length + importantChanges.length} meaningful trend changes found.`
          : "Trend monitoring is ready, but it needs a configured source or an initial snapshot.",
        sections: [
          { title: "New developments", items: meaningfulNew.map((item) => `${item.title}: ${item.summary}`) },
          { title: "Important changes", items: importantChanges.map((item) => `${item.title}: ${item.summary}`) },
          { title: "Emerging patterns", items: emergingPatterns },
          { title: "Needs attention", items: attention },
        ],
        data: { ...data },
        warnings,
      };
      const output = await context.vault.writeOutput({
        kind: "trend_report",
        type: "trend-report",
        topic: "trend-report",
        title: `Trend report ${context.now.toISOString().slice(0, 10)}`,
        summary: current
          ? "Meaningful developments and changes compared with the previous trend snapshot."
          : "The trend scan completed without a configured source or initial snapshot.",
        content: renderSections(result.summary, result.sections),
        tags: ["trends", "delta"],
        data: { ...data },
      });
      result.data.outputId = output.id;
      return result;
    },
  };
}
