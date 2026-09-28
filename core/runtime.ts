import { randomUUID } from "node:crypto";
import { loadConfig, type UltronConfig } from "./config.ts";
import { ConversationBrain } from "./brain.ts";
import { ConversationMemory } from "./conversationMemory.ts";
import { createBrainVaultTool } from "./integrations/brainVault.ts";
import { ModelProviderError, OpenAIResponsesProvider, type LanguageModelProvider } from "./llm.ts";
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
  sessionId?: string;
  source?: "text" | "voice";
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
  provider?: LanguageModelProvider;
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
  readonly conversation = new ConversationMemory();
  private readonly brain?: ConversationBrain;

  constructor(dependencies: RuntimeDependencies = {}) {
    this.config = dependencies.config ?? loadConfig();
    this.vault = dependencies.vault ?? new MarkdownVault(this.config.vaultDir, { timezone: this.config.timezone });
    this.permissions =
      dependencies.permissions ??
      new PermissionService(new JsonFilePermissionGrantStore(this.config.dataDir));
    this.logger = dependencies.logger ?? new ConsoleLogger();
    this.tools = new ToolRegistry(this.permissions, this.logger);
    this.tools.register(createGitHubMetricsTool(this.config));
    this.tools.register(createBrainVaultTool(this.vault));
    const brainConfig = this.config.brain;
    const provider = dependencies.provider ?? (brainConfig?.provider === "openai" && brainConfig.apiKey
      ? new OpenAIResponsesProvider({ ...brainConfig, apiKey: brainConfig.apiKey }) : undefined);
    if (provider) this.brain = new ConversationBrain(provider, this.tools);

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

  brainStatus() {
    return {
      configured: Boolean(this.brain),
      provider: this.config.brain?.provider ?? "disabled",
      model: this.config.brain?.model ?? null,
      capabilities: ["conversation", "writing", "translation", "message_drafts", "approved_vault_context"],
      connectedServices: this.config.github.repositories.length ? ["github_public_read"] : [],
    };
  }

  clearConversation(sessionId = "local"): boolean {
    if (!this.conversation.clear(sessionId)) return false;
    this.brain?.clear(sessionId);
    return true;
  }

  async execute(request: RuntimeRequest): Promise<RuntimeResponse> {
    const sessionId = request.sessionId ?? "local";
    const source = request.source ?? "text";
    if (!this.conversation.begin(sessionId)) {
      return { status: "error", requestId: randomUUID(), human: "Ultron is already working on this conversation. Try again when it finishes." };
    }
    try {
      if (!request.confirmationId) {
        this.conversation.pending(sessionId);
        this.brain?.clear(sessionId);
        this.conversation.add(sessionId, "user", request.message, source);
      }
      const response = await this.executeRequest(request);
      if (response.status === "confirmation_required") {
        this.conversation.pending(sessionId, { message: request.message, challenge: response.confirmation });
      } else {
        this.conversation.pending(sessionId);
        const cloud = response.status === "ok" && response.output.skill === "conversation";
        if (cloud) this.conversation.approveForCloud(sessionId);
        this.conversation.add(sessionId, "assistant", response.human, source, cloud);
      }
      return response;
    } finally { this.conversation.finish(sessionId); }
  }

  private async executeRequest(request: RuntimeRequest): Promise<RuntimeResponse> {
    const requestId = randomUUID();
    const message = request.message.trim();
    if (!message) return { status: "error", requestId, human: "Enter a request for Ultron." };

    // Dictation is an exact local text operation, never a cloud-model request.
    const dictated = message.match(/^(?:dictate|write this down|type this)(?:\s*[:,-]\s*|\s+)([\s\S]+)$/i);
    if (dictated) {
      const text = dictated[1].trim();
      return {
        status: "ok", requestId,
        route: { target: { type: "workflow", id: "dictation" }, score: 100, matchedPhrase: "dictate" },
        human: text,
        output: { skill: "dictation", timestamp: new Date().toISOString(), summary: text, sections: [], data: { text, cloudUsed: false, saved: false }, warnings: [] },
      };
    }
    const authoring = /^(?:draft|translate|rewrite|rephrase|explain|compose|reply|write (?:an? |the |some |code|me ))/i.test(message);
    const route = authoring ? null : this.router.route(message);
    if (!route) {
      return this.executeConversation(request, requestId);
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

  cancelConfirmation(sessionId = "local"): boolean {
    if (this.conversation.snapshot(sessionId).busy) return false;
    this.conversation.pending(sessionId);
    this.brain?.clear(sessionId);
    return true;
  }

  private async executeConversation(request: RuntimeRequest, requestId: string): Promise<RuntimeResponse> {
    if (!this.brain) {
      return { status: "unsupported", requestId, human: "Ultron's conversational brain needs configuration. Add OPENAI_API_KEY privately in .env.local and restart Ultron. Local dictation, plan, inbox, metrics, trends, and Vault commands still work." };
    }
    const route: RouteDecision = { target: { type: "workflow", id: "conversation" }, score: 0, matchedPhrase: "conversation" };
    const sessionId = request.sessionId ?? "local";
    const startedAt = performance.now();
    this.logger.log("info", "brain.started", { requestId, provider: this.config.brain?.provider ?? "injected" });
    try {
      const text = await this.brain.reply(sessionId, [
        ...this.conversation.history(sessionId),
        { role: "user", content: request.message },
      ], { requestId, message: request.message, confirmationId: request.confirmationId, rememberPermission: request.rememberPermission });
      this.logger.log("info", "brain.completed", { requestId, durationMs: Math.round(performance.now() - startedAt) });
      return {
        status: "ok", requestId, route, human: text,
        output: { skill: "conversation", timestamp: new Date().toISOString(), summary: text, sections: [], data: { draftOnly: true }, warnings: [] },
      };
    } catch (error) {
      if (error instanceof PermissionRequiredError) return { status: "confirmation_required", requestId, route, confirmation: error.challenge };
      const code = error instanceof ModelProviderError ? error.code : "conversation_failed";
      this.logger.log("error", "brain.failed", { requestId, code });
      const human = code === "authentication" ? "The cloud API key was rejected. Check OPENAI_API_KEY privately and restart Ultron."
        : code === "rate_limit" ? "The cloud provider rejected this request because of a usage or rate limit. Check your API billing and retry later."
        : code === "timeout" ? "The cloud response timed out. Local skill and dictation commands are still available."
        : "The conversational brain could not complete this request. Nothing was sent or changed in your external applications.";
      return { status: "error", requestId, human };
    }
  }
}

export function getUltronRuntime(): UltronRuntime {
  // Share voice/text working memory across route bundles and development reloads.
  const shared = globalThis as typeof globalThis & { __ultronRuntime?: UltronRuntime };
  shared.__ultronRuntime ??= new UltronRuntime();
  return shared.__ultronRuntime;
}
