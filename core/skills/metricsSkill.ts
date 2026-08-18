import type { GitHubMetricsOutput, GitHubRepositoryMetric } from "../integrations/github.ts";
import type { VaultEntry } from "../vault.ts";
import { renderSections, type SkillDefinition, type SkillResult } from "./types.ts";

export interface ManualMetric {
  name: string;
  value: string | number;
  unit?: string;
  source: string;
  change?: string;
  anomalous?: boolean;
  attention?: string;
}

export interface MetricsSkillData {
  repositories: GitHubRepositoryMetric[];
  manual: ManualMetric[];
  changes: string[];
  anomalies: string[];
  attention: string[];
  snapshotId?: string;
}

function parseRepositories(entry: VaultEntry | undefined): GitHubRepositoryMetric[] {
  if (!entry || !Array.isArray(entry.data.repositories)) return [];
  return entry.data.repositories.filter((value): value is GitHubRepositoryMetric => {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<GitHubRepositoryMetric>;
    return typeof item.repository === "string" && typeof item.openIssues === "number";
  });
}

function parseManualMetrics(entries: VaultEntry[]): ManualMetric[] {
  for (const entry of entries) {
    if (!Array.isArray(entry.data.points)) continue;
    return entry.data.points.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (typeof item.name !== "string" || !["string", "number"].includes(typeof item.value)) return [];
      return [{
        name: item.name,
        value: item.value as string | number,
        ...(typeof item.unit === "string" ? { unit: item.unit } : {}),
        source: typeof item.source === "string" ? item.source : "manual",
        ...(typeof item.change === "string" ? { change: item.change } : {}),
        ...(typeof item.anomalous === "boolean" ? { anomalous: item.anomalous } : {}),
        ...(typeof item.attention === "string" ? { attention: item.attention } : {}),
      }];
    });
  }
  return [];
}

function daysSince(timestamp: string | null, now: Date): number | null {
  if (!timestamp) return null;
  return Math.floor((now.getTime() - Date.parse(timestamp)) / 86_400_000);
}

export function createMetricsSkill(): SkillDefinition<MetricsSkillData> {
  return {
    id: "metrics",
    name: "Metrics",
    description: "Summarize important configured metrics, changes, anomalies, and attention items.",
    priority: 2,
    routes: [
      { phrases: ["how are things performing", "show me today's numbers", "give me the numbers", "anything unusual in the metrics"], weight: 12 },
      { phrases: ["metrics", "github activity", "project progress", "portfolio visitors", "gym progress", "expenses"], weight: 8 },
    ],
    async execute(context): Promise<SkillResult<MetricsSkillData>> {
      const existingSnapshots = await context.vault.search({
        namespace: "knowledge",
        kind: "metric_snapshot",
        limit: 20,
      });
      const previousRepositories = parseRepositories(
        existingSnapshots.find((entry) => Array.isArray(entry.data.repositories)),
      );
      const previousByRepository = new Map(previousRepositories.map((item) => [item.repository, item]));
      const manual = parseManualMetrics(existingSnapshots);
      let repositories: GitHubRepositoryMetric[] = [];
      const warnings: string[] = [];

      if (context.config.github.repositories.length > 0) {
        const output = await context.tools.invoke<{ repositories: string[] }, GitHubMetricsOutput>(
          "github.repository.metrics",
          { repositories: context.config.github.repositories },
          {
            requestId: context.requestId,
            message: context.message,
            ...(context.confirmationId ? { confirmationId: context.confirmationId } : {}),
            ...(context.rememberPermission === true ? { rememberPermission: true } : {}),
          },
        );
        repositories = output.repositories;
      } else {
        warnings.push("No GitHub repositories are configured in ULTRON_GITHUB_REPOSITORIES.");
      }

      const changes: string[] = [];
      const anomalies: string[] = [];
      const attention: string[] = [];

      for (const repository of repositories) {
        const previous = previousByRepository.get(repository.repository);
        if (previous) {
          const issueDelta = repository.openIssues - previous.openIssues;
          const starDelta = repository.stars - previous.stars;
          if (issueDelta !== 0) changes.push(`${repository.repository}: open issues ${issueDelta > 0 ? "+" : ""}${issueDelta}`);
          if (starDelta !== 0) changes.push(`${repository.repository}: stars ${starDelta > 0 ? "+" : ""}${starDelta}`);
        }
        if (repository.archived) anomalies.push(`${repository.repository} is archived.`);
        const idleDays = daysSince(repository.pushedAt, context.now);
        if (idleDays !== null && idleDays >= 14) {
          attention.push(`${repository.repository} has not received a push for ${idleDays} days.`);
        }
      }

      for (const metric of manual) {
        if (metric.change) changes.push(`${metric.name}: ${metric.change}`);
        if (metric.anomalous) anomalies.push(`${metric.name} is marked as unusual.`);
        if (metric.attention) attention.push(metric.attention);
      }

      if (repositories.length === 0 && manual.length === 0) {
        warnings.push("No manual metric snapshot exists yet for expenses, gym, college, or portfolio traffic.");
      }

      const data: MetricsSkillData = {
        repositories,
        manual,
        changes,
        anomalies,
        attention,
      };
      const result: SkillResult<MetricsSkillData> = {
        skill: "metrics",
        timestamp: context.now.toISOString(),
        summary:
          repositories.length + manual.length > 0
            ? `${repositories.length + manual.length} important metric sources summarized.`
            : "Metrics is ready, but it needs configured or manually recorded data.",
        sections: [
          {
            title: "Important numbers",
            items: [
              ...repositories.map(
                (item) => `${item.repository}: ${item.openIssues} open issues, ${item.stars} stars, ${item.forks} forks`,
              ),
              ...manual.map((item) => `${item.name}: ${item.value}${item.unit ? ` ${item.unit}` : ""}`),
            ],
          },
          { title: "Changes", items: changes },
          { title: "Anomalies", items: anomalies },
          { title: "Needs attention", items: attention },
        ],
        data,
        warnings,
      };
      const output = await context.vault.writeOutput({
        kind: "metric_snapshot",
        type: "metrics-report",
        topic: "metrics-report",
        title: `Metrics report ${context.now.toISOString().slice(0, 10)}`,
        summary: repositories.length + manual.length > 0
          ? "A concise snapshot of important metrics, changes, anomalies, and attention items."
          : "The metrics scan completed without configured or manually recorded data.",
        content: renderSections(result.summary, result.sections),
        tags: ["metrics", ...(repositories.length ? ["github"] : [])],
        data: { repositories, manual, changes, anomalies, attention },
      });
      result.data.snapshotId = output.id;
      return result;
    },
  };
}
