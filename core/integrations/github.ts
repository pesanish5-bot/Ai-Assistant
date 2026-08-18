import type { UltronConfig } from "../config.ts";
import type { ToolDefinition } from "../tools.ts";

export interface GitHubRepositoryMetric {
  repository: string;
  defaultBranch: string;
  stars: number;
  forks: number;
  openIssues: number;
  archived: boolean;
  pushedAt: string | null;
  updatedAt: string;
}

export interface GitHubMetricsInput {
  repositories: string[];
}

export interface GitHubMetricsOutput {
  retrievedAt: string;
  repositories: GitHubRepositoryMetric[];
}

interface GitHubRepositoryResponse {
  full_name: string;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  archived: boolean;
  pushed_at: string | null;
  updated_at: string;
}

export function createGitHubMetricsTool(config: UltronConfig): ToolDefinition<GitHubMetricsInput, GitHubMetricsOutput> {
  return {
    name: "github.repository.metrics",
    description: "Read public activity and health metrics for configured GitHub repositories.",
    risk: "read",
    permissionScope: "github:read:repository-metrics",
    async execute(input) {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "ultron-personal-ai-os",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (config.github.token) headers.Authorization = `Bearer ${config.github.token}`;

      const repositories = await Promise.all(
        input.repositories.map(async (repository): Promise<GitHubRepositoryMetric> => {
          const response = await fetch(`https://api.github.com/repos/${repository}`, { headers });
          if (!response.ok) {
            throw new Error(`GitHub repository read failed for ${repository} (${response.status}).`);
          }
          const data = (await response.json()) as GitHubRepositoryResponse;
          return {
            repository: data.full_name,
            defaultBranch: data.default_branch,
            stars: data.stargazers_count,
            forks: data.forks_count,
            openIssues: data.open_issues_count,
            archived: data.archived,
            pushedAt: data.pushed_at,
            updatedAt: data.updated_at,
          };
        }),
      );

      return { retrievedAt: new Date().toISOString(), repositories };
    },
  };
}
