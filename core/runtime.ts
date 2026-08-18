import { randomUUID } from "node:crypto";
import { loadConfig, type UltronConfig } from "./config.ts";
import { createGitHubMetricsTool } from "./integrations/github.ts";
import { ConsoleLogger, type Logger } from "./observability.ts";
import {
  JsonFilePermissionGrantStore,
  PermissionRequiredError,
  PermissionService,
  type PermissionChallenge,
} from "./permissions.ts";
import { createInboxSkill } from "./skills/inboxSkill.ts";
import { createMetricsSkill } from "./skills/metricsSkill.ts";
import { createPlanSkill } from "./skills/planSkill.ts";
import { SkillRegistry } from "./skills/registry.ts";
import { IntentRouter, type RouteDecision } from "./skills/router.ts";
import { createTrendsSkill } from "./skills/trendsSkill.ts";
import { renderSections, type SkillExecutionContext, type SkillResult } from "./skills/types.ts";
import { createVaultSkill } from "./skills/vaultSkill.ts";
import { ToolRegistry } from "./tools.ts";
import { MarkdownVault, type Vault } from "./vault.ts";

export interface RuntimeRequest {
  message: string;
  confirmationId?: string;
  rememberPermission?: boolean;
}

export type RuntimeResponse =
  | {
      status: "ok";
      requestId: string;
      route: RouteDecision;
      human: string;
      output: SkillResult<unknown>;
    }
  | {
      status: "confirmation_required";
      requestId: string;
      route: RouteDecision;
      confirmation: PermissionChallenge;
    }
  | {
      status: "unsupported";
      requestId: string;
      human: string;
    }
  | {
      status: "error";
      requestId: string;
      human: string;
    };

interface RuntimeDependencies {
  config?: UltronConfig;
  vault?: Vault;
  permissions?: PermissionService;
  logger?: Logger;
}

interface MorningData {
  inbox: unknown;
  metrics: unknown;
  trends: unknown;
  plan: unknown;
}

export class UltronRuntime {
  readonly config: UltronConfig;
  readonly vault: Vault;
  readonly permissions: PermissionService;
  readonly logger: Logger;
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  readonly router: IntentRouter;

  constructor(dependencies: RuntimeDependencies = {}) {
    this.config = dependencies.config ?? loadConfig();
    this.vault = dependencies.vault ?? new MarkdownVault(this.config.vaultDir, { timezone: this.config.timezone });
    this.permissions =
      dependencies.permissions ??
      new PermissionService(new JsonFilePermissionGrantStore(this.config.dataDir));
    this.logger = dependencies.logger ?? new ConsoleLogger();
    this.tools = new ToolRegistry(this.permissions, this.logger);
    this.tools.register(createGitHubMetricsTool(this.config));

    this.skills = new SkillRegistry();
    this.skills.register(createVaultSkill());
    this.skills.register(createInboxSkill());
    this.skills.register(createMetricsSkill());
    this.skills.register(createTrendsSkill());
    this.skills.register(createPlanSkill());

    this.router = new IntentRouter(this.skills);
    this.router.registerWorkflow(
      "morning",
      [
        { phrases: ["good morning", "start my day", "daily operating brief"], weight: 15 },
        { phrases: ["give me my morning brief", "morning briefing"], weight: 13 },
      ],
      5,
    );
  }

  private async executeSkill(
    id: string,
    request: RuntimeRequest,
    requestId: string,
    now: Date,
    priorResults: Map<string, SkillResult<unknown>>,
  ): Promise<SkillResult<unknown>> {
    const skill = this.skills.get(id);
    const context: SkillExecutionContext = {
      message: request.message,
      requestId,
      ...(request.confirmationId ? { confirmationId: request.confirmationId } : {}),
      ...(request.rememberPermission === true ? { rememberPermission: true } : {}),
      now,
      config: this.config,
      vault: this.vault,
      tools: this.tools,
      logger: this.logger,
      priorResults,
    };
    const startedAt = performance.now();
    this.logger.log("info", "skill.started", { requestId, skill: id });
    try {
      const output = await skill.execute(context);
      priorResults.set(id, output);
      this.logger.log("info", "skill.completed", {
        requestId,
        skill: id,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return output;
    } catch (error) {
      this.logger.log(error instanceof PermissionRequiredError ? "info" : "error", "skill.failed", {
        requestId,
        skill: id,
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof PermissionRequiredError ? "permission_required" : error instanceof Error ? error.message : "Unknown skill failure",
      });
      throw error;
    }
  }

  private async executeMorning(
    request: RuntimeRequest,
    requestId: string,
    now: Date,
  ): Promise<SkillResult<MorningData>> {
    const priorResults = new Map<string, SkillResult<unknown>>();
    const inbox = await this.executeSkill("inbox", request, requestId, now, priorResults);
    const metrics = await this.executeSkill("metrics", request, requestId, now, priorResults);
    const trends = await this.executeSkill("trends", request, requestId, now, priorResults);
    const plan = await this.executeSkill("plan", request, requestId, now, priorResults);
    const planItems = plan.sections.find((section) => section.title === "Today")?.items ?? [];
    const inboxItems = inbox.data && typeof inbox.data === "object" && Array.isArray((inbox.data as Record<string, unknown>).items)
      ? ((inbox.data as Record<string, unknown>).items as Array<Record<string, unknown>>)
          .map((item) => (typeof item.summary === "string" ? item.summary : ""))
          .filter(Boolean)
      : [];
    const trendItems = trends.sections
      .filter((section) => section.title === "New developments" || section.title === "Important changes")
      .flatMap((section) => section.items);
    const numberItems = metrics.sections.find((section) => section.title === "Important numbers")?.items ?? [];
    const warnings = [...new Set([...inbox.warnings, ...metrics.warnings, ...trends.warnings, ...plan.warnings])];
    const output: SkillResult<MorningData> = {
      skill: "morning",
      timestamp: now.toISOString(),
      summary: "Your daily operating brief is ready.",
      sections: [
        { title: "Today", items: planItems },
        { title: "Needs attention", items: inboxItems },
        { title: "What's changed", items: trendItems },
        { title: "Numbers", items: numberItems },
      ],
      data: { inbox: inbox.data, metrics: metrics.data, trends: trends.data, plan: plan.data },
      warnings,
    };
    await this.vault.writeOutput({
      kind: "briefing",
      type: "morning-brief",
      topic: "morning-brief",
      title: `Morning brief ${now.toISOString().slice(0, 10)}`,
      summary: "The combined daily brief from Inbox, Metrics, Trends, and Plan.",
      content: renderSections(output.summary, output.sections),
      tags: ["briefing", "morning"],
      data: { skills: ["inbox", "metrics", "trends", "plan"] },
    });
    return output;
  }

  async execute(request: RuntimeRequest): Promise<RuntimeResponse> {
    const requestId = randomUUID();
    const message = request.message.trim();
    if (!message) return { status: "error", requestId, human: "Enter a request for Ultron." };

    const route = this.router.route(message);
    if (!route) {
      this.logger.log("info", "route.unsupported", { requestId });
      return {
        status: "unsupported",
        requestId,
        human: "I cannot route that request yet. Try asking about your inbox, metrics, trends, plan, or Vault.",
      };
    }

    this.logger.log("info", "route.selected", {
      requestId,
      targetType: route.target.type,
      target: route.target.id,
      score: route.score,
    });
    const now = new Date();
    try {
      const output =
        route.target.type === "workflow" && route.target.id === "morning"
          ? await this.executeMorning(request, requestId, now)
          : await this.executeSkill(route.target.id, request, requestId, now, new Map());
      const warningText = output.warnings.length
        ? `\n\nConfiguration notes\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
        : "";
      return {
        status: "ok",
        requestId,
        route,
        human: `${renderSections(output.summary, output.sections)}${warningText}`,
        output,
      };
    } catch (error) {
      if (error instanceof PermissionRequiredError) {
        return {
          status: "confirmation_required",
          requestId,
          route,
          confirmation: error.challenge,
        };
      }
      this.logger.log("error", "request.failed", {
        requestId,
        target: route.target.id,
        error: error instanceof Error ? error.message : "Unknown runtime failure",
      });
      return {
        status: "error",
        requestId,
        human: "Ultron could not complete that request. Check the server log for the safe error summary.",
      };
    }
  }
}

let runtime: UltronRuntime | undefined;

export function getUltronRuntime(): UltronRuntime {
  runtime ??= new UltronRuntime();
  return runtime;
}
