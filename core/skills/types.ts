import type { UltronConfig } from "../config.ts";
import type { Logger } from "../observability.ts";
import type { ToolRegistry } from "../tools.ts";
import type { Vault } from "../vault.ts";

export interface SkillSection {
  title: string;
  items: string[];
}

export interface SkillResult<TData = Record<string, unknown>> {
  skill: string;
  timestamp: string;
  summary: string;
  sections: SkillSection[];
  data: TData;
  warnings: string[];
}

export interface SkillExecutionContext {
  message: string;
  requestId: string;
  confirmationId?: string;
  rememberPermission?: boolean;
  now: Date;
  config: UltronConfig;
  vault: Vault;
  tools: ToolRegistry;
  logger: Logger;
  priorResults: Map<string, SkillResult<unknown>>;
}

export interface RouteRule {
  phrases: string[];
  weight: number;
}

export interface SkillDefinition<TData = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  priority?: number;
  routes: RouteRule[];
  execute(context: SkillExecutionContext): Promise<SkillResult<TData>>;
}

export function renderSections(summary: string, sections: SkillSection[]): string {
  const rendered = sections
    .filter((section) => section.items.length > 0)
    .map((section) => `${section.title}\n${section.items.map((item) => `- ${item}`).join("\n")}`)
    .join("\n\n");

  return rendered ? `${summary}\n\n${rendered}` : summary;
}
