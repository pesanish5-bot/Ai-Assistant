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

export interface GitHubActivityItem {
  repository: string;
  kind: "commit" | "issue" | "pull_request";
  id: string;
  title: string;
  summary: string;
  updatedAt: string;
  url: string;
}

export interface GitHubActivityOutput {
  retrievedAt: string;
  items: GitHubActivityItem[];
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

function githubHeaders(config: UltronConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ultron-personal-ai-os",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (config.github.token) headers.Authorization = `Bearer ${config.github.token}`;
  return headers;
}

function repositoryParts(repository: string): { owner: string; name: string } {
  const slash = repository.indexOf("/");
  const owner = repository.slice(0, slash);
  const name = repository.slice(slash + 1);
  if (!owner || !name || name.includes("/")) throw new Error(`Invalid GitHub repository: ${repository}.`);
  return { owner, name };
}

async function githubGet(repository: string, path: string, headers: Record<string, string>): Promise<unknown> {
  const { owner, name } = repositoryParts(repository);
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${path}`,
      { headers, redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new Error(timedOut ? `GitHub read timed out for ${repository}.` : `GitHub read failed for ${repository}.`);
  }
  if (!response.ok) throw new Error(`GitHub read failed for ${repository} (${response.status}).`);
  return response.json();
}

function textField(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function createGitHubMetricsTool(config: UltronConfig): ToolDefinition<GitHubMetricsInput, GitHubMetricsOutput> {
  return {
    name: "github.repository.metrics",
    description: "Read public activity and health metrics for configured GitHub repositories.",
    risk: "read",
    permissionScope: "github:read:repository-metrics",
    async execute(input) {
      const headers = githubHeaders(config);
      const repositories = await Promise.all(
        input.repositories.map(async (repository): Promise<GitHubRepositoryMetric> => {
          const data = (await githubGet(repository, "", headers)) as GitHubRepositoryResponse;
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

export function createGitHubActivityTool(config: UltronConfig): ToolDefinition<GitHubMetricsInput, GitHubActivityOutput> {
  return {
    name: "github.repository.activity",
    description: "Read recent commits and open issues or pull requests for configured GitHub repositories.",
    risk: "read",
    permissionScope: "github:read:activity",
    async execute(input) {
      const headers = githubHeaders(config);
      const groups = await Promise.all(input.repositories.map(async (repository) => {
        const [commits, issues] = await Promise.all([
          githubGet(repository, "/commits?per_page=5", headers),
          githubGet(repository, "/issues?state=open&per_page=8", headers),
        ]);
        const commitItems = (Array.isArray(commits) ? commits : []).flatMap((value): GitHubActivityItem[] => {
          if (!value || typeof value !== "object") return [];
          const item = value as Record<string, unknown>;
          const commit = item.commit && typeof item.commit === "object" ? item.commit as Record<string, unknown> : {};
          const author = commit.author && typeof commit.author === "object" ? commit.author as Record<string, unknown> : {};
          const title = textField(commit.message, 180).split("\n")[0];
          const id = textField(item.sha, 80);
          if (!title || !id) return [];
          return [{
            repository, kind: "commit", id: `${repository}:commit:${id.slice(0, 12)}`, title,
            summary: title, updatedAt: textField(author.date, 40), url: textField(item.html_url, 300),
          }];
        });
        const issueItems = (Array.isArray(issues) ? issues : []).flatMap((value): GitHubActivityItem[] => {
          if (!value || typeof value !== "object") return [];
          const item = value as Record<string, unknown>;
          const title = textField(item.title, 180);
          const number = typeof item.number === "number" ? item.number : 0;
          if (!title || number <= 0) return [];
          const kind = item.pull_request ? "pull_request" : "issue";
          return [{
            repository, kind, id: `${repository}:${kind}:${number}`, title,
            summary: title, updatedAt: textField(item.updated_at, 40), url: textField(item.html_url, 300),
          }];
        });
        return [...commitItems, ...issueItems];
      }));
      return { retrievedAt: new Date().toISOString(), items: groups.flat() };
    },
  };
}
