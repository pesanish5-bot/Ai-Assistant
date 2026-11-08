import type { GitHubActivityItem } from "../integrations/github.ts";
import type { SkillExecutionContext } from "./types.ts";
import { calendarDate, type VaultEntry } from "../vault.ts";
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
  activity: GitHubActivityItem[];
  currentSnapshotId?: string;
  previousSnapshotId?: string;
  outputId?: string;
}

export async function loadGitHubActivity(context: SkillExecutionContext): Promise<GitHubActivityItem[]> {
  if (context.config.github.repositories.length === 0) return [];
  const output = await context.tools.invoke<{ repositories: string[] }, { items: GitHubActivityItem[] }>(
    "github.repository.activity",
    { repositories: context.config.github.repositories },
    {
      requestId: context.requestId,
      message: context.message,
      ...(context.confirmationId ? { confirmationId: context.confirmationId } : {}),
      ...(context.rememberPermission === true ? { rememberPermission: true } : {}),
    },
  );
  return Array.isArray(output.items) ? output.items : [];
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
      const activity = await loadGitHubActivity(context);
      const snapshots = await context.vault.search({ namespace: "knowledge", kind: "trend_snapshot", limit: 2 });
      const reports = activity.length > 0 ? await context.vault.search({ kind: "trend_report", limit: 8 }) : [];
      const storedCurrent = activity.length > 0 ? undefined : snapshots[0];
      const previous = activity.length > 0 ? reports.find((entry) => Array.isArray(entry.data.items)) : snapshots[1];
      const currentItems = activity.length > 0
        ? activity.map((item) => ({ id: item.id, title: item.title, summary: `${item.repository}: ${item.summary}`, source: item.kind, tags: [item.kind, item.repository], ...(item.kind !== "commit" ? { attention: `Review ${item.title}` } : {}) }))
        : parseItems(storedCurrent);
      const previousById = new Map(parseItems(previous).map((item) => [item.id, item]));
      const meaningfulNew = currentItems.filter((item) => !previousById.has(item.id));
      const importantChanges = currentItems.filter((item) => {
        const before = previousById.get(item.id);
        return before !== undefined && before.summary !== item.summary;
      });
      const emergingPatterns = findPatterns([...meaningfulNew, ...importantChanges]);
      const attention = currentItems.flatMap((item) => (item.attention ? [item.attention] : []));
      const warnings: string[] = [];

      if (activity.length === 0 && !storedCurrent) warnings.push("No trend source is configured and no Vault trend snapshot exists yet.");
      else if (!previous) warnings.push("A previous trend snapshot is needed before a reliable delta can be calculated.");

      const data: TrendsSkillData = {
        meaningfulNew,
        importantChanges,
        emergingPatterns,
        attention,
        activity,
        ...(storedCurrent ? { currentSnapshotId: storedCurrent.id } : {}),
        ...(previous ? { previousSnapshotId: previous.id } : {}),
      };

      const result: SkillResult<TrendsSkillData> = {
        skill: "trends",
        timestamp: context.now.toISOString(),
        summary: currentItems.length > 0
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
        title: `Trend report ${calendarDate(context.now, context.config.timezone)}`,
        summary: currentItems.length > 0
          ? "Meaningful developments and changes compared with the previous trend snapshot."
          : "The trend scan completed without a configured source or initial snapshot.",
        content: renderSections(result.summary, result.sections),
        tags: ["trends", "delta"],
        data: { ...data, items: currentItems },
      });
      result.data.outputId = output.id;
      return result;
    },
  };
}
