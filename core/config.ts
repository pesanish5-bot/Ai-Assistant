import path from "node:path";

export interface UltronConfig {
  dataDir: string;
  vaultDir: string;
  timezone: string;
  github: {
    repositories: string[];
    token?: string;
  };
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseRepositories(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const repositories = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  const invalid = repositories.filter((repository) => !REPOSITORY_PATTERN.test(repository));

  if (invalid.length > 0) {
    throw new Error(
      `Invalid ULTRON_GITHUB_REPOSITORIES value: ${invalid.join(", ")}. Expected owner/repository.`,
    );
  }

  return repositories;
}

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
  workingDirectory = process.cwd(),
): UltronConfig {
  const configuredDataDir = environment.ULTRON_DATA_DIR?.trim() || ".ultron";
  const configuredVaultDir = environment.ULTRON_VAULT_DIR?.trim();
  const dataDir = path.resolve(workingDirectory, configuredDataDir);
  const timezone =
    environment.ULTRON_TIMEZONE?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";
  const token = environment.GITHUB_TOKEN?.trim();

  return {
    dataDir,
    vaultDir: configuredVaultDir
      ? path.resolve(workingDirectory, configuredVaultDir)
      : path.join(dataDir, "vault"),
    timezone,
    github: {
      repositories: parseRepositories(environment.ULTRON_GITHUB_REPOSITORIES),
      ...(token ? { token } : {}),
    },
  };
}
