import path from "node:path";

export interface UltronConfig {
  dataDir: string;
  vaultDir: string;
  timezone: string;
  brain?: {
    provider: "openai" | "disabled";
    model: string;
    apiKey?: string;
    timeoutMs: number;
    maxOutputTokens: number;
  };
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
  const provider = environment.ULTRON_LLM_PROVIDER?.trim() || "openai";
  if (provider !== "openai" && provider !== "disabled") {
    throw new Error("ULTRON_LLM_PROVIDER must be openai or disabled.");
  }
  const model = environment.ULTRON_LLM_MODEL?.trim() || "gpt-6-sol";
  if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(model)) throw new Error("Invalid ULTRON_LLM_MODEL.");
  const apiKey = environment.OPENAI_API_KEY?.trim();

  return {
    dataDir,
    vaultDir: configuredVaultDir
      ? path.resolve(workingDirectory, configuredVaultDir)
      : path.join(dataDir, "vault"),
    timezone,
    brain: {
      provider,
      model,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: 25_000,
      maxOutputTokens: 2_048,
    },
    github: {
      repositories: parseRepositories(environment.ULTRON_GITHUB_REPOSITORIES),
      ...(token ? { token } : {}),
    },
  };
}
