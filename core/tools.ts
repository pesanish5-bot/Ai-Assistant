import type { Logger } from "./observability.ts";
import {
  digestPermissionInput,
  fingerprintPermissionMessage,
  type PermissionRequest,
  type PermissionRisk,
  type PermissionService,
} from "./permissions.ts";

export interface ToolExecutionContext {
  requestId: string;
  logger: Logger;
}

export interface ToolInvocationRequest {
  requestId: string;
  message: string;
  confirmationId?: string;
  rememberPermission?: boolean;
}

export interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  risk: PermissionRisk;
  permissionScope: string | ((input: TInput) => string);
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

type UnknownToolDefinition = ToolDefinition<unknown, unknown>;

export class ToolRegistry {
  private readonly definitions = new Map<string, UnknownToolDefinition>();
  private readonly permissions: PermissionService;
  private readonly logger: Logger;

  constructor(permissions: PermissionService, logger: Logger) {
    this.permissions = permissions;
    this.logger = logger;
  }

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    if (!/^[a-z][a-z0-9_.-]*$/.test(definition.name)) {
      throw new Error(`Malformed tool name: ${definition.name}`);
    }
    if (this.definitions.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition as UnknownToolDefinition);
  }

  list(): Array<Pick<UnknownToolDefinition, "name" | "description" | "risk">> {
    return [...this.definitions.values()].map(({ name, description, risk }) => ({
      name,
      description,
      risk,
    }));
  }

  async invoke<TInput, TOutput>(
    name: string,
    input: TInput,
    invocation: ToolInvocationRequest,
  ): Promise<TOutput> {
    const definition = this.definitions.get(name) as ToolDefinition<TInput, TOutput> | undefined;
    if (!definition) throw new Error(`Unknown tool: ${name}`);

    const scope =
      typeof definition.permissionScope === "function"
        ? definition.permissionScope(input)
        : definition.permissionScope;
    const permission: PermissionRequest = {
      scope,
      toolName: definition.name,
      description: definition.description,
      risk: definition.risk,
      inputDigest: digestPermissionInput(input),
      requestFingerprint: fingerprintPermissionMessage(invocation.message),
    };

    await this.permissions.require(
      permission,
      invocation.confirmationId
        ? { id: invocation.confirmationId, remember: invocation.rememberPermission === true }
        : undefined,
    );

    const startedAt = performance.now();
    this.logger.log("info", "tool.started", {
      requestId: invocation.requestId,
      tool: name,
      risk: definition.risk,
    });
    try {
      const output = await definition.execute(input, {
        requestId: invocation.requestId,
        logger: this.logger,
      });
      this.logger.log("info", "tool.completed", {
        requestId: invocation.requestId,
        tool: name,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return output;
    } catch (error) {
      this.logger.log("error", "tool.failed", {
        requestId: invocation.requestId,
        tool: name,
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : "Unknown tool failure",
      });
      throw error;
    }
  }
}
