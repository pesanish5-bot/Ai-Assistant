import type { ToolDefinition } from "../tools.ts";
import type { Vault } from "../vault.ts";

export function createBrainVaultTool(vault: Vault): ToolDefinition<{ query: string }, unknown> {
  return {
    name: "brain.vault.search",
    description: "Share up to three matching Vault excerpts with the configured cloud model for this conversation.",
    risk: "read",
    permissionScope: "cloud.context.vault",
    async execute(input) {
      if (!input || typeof input.query !== "string" || !input.query.trim() || input.query.length > 200) {
        throw new Error("Vault search requires a query of 1–200 characters.");
      }
      const entries = await vault.search({ layer: "wiki", text: input.query, limit: 8 });
      return entries.filter((entry) => !entry.tags.some((tag) => /^(private|local-only|no-cloud|sensitive)$/i.test(tag)))
        .slice(0, 3).map((entry) => ({ id: entry.id, title: entry.title.slice(0, 150), summary: entry.summary.slice(0, 500), excerpt: entry.content.slice(0, 1_800) }));
    },
  };
}
