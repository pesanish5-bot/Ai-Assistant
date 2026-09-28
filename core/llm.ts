export interface LanguageModelRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  responseFormat?: "text" | "json";
  continuation?: Record<string, unknown>[];
  tools?: ModelFunctionTool[];
}

export interface LanguageModelResponse {
  text: string;
  model: string;
  output?: Record<string, unknown>[];
  toolCalls?: ModelToolCall[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface LanguageModelProvider {
  readonly id: string;
  generate(request: LanguageModelRequest): Promise<LanguageModelResponse>;
}

export interface ModelFunctionTool {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export class ModelProviderError extends Error {
  readonly code: "configuration" | "authentication" | "rate_limit" | "timeout" | "unavailable" | "invalid_response";
  constructor(code: ModelProviderError["code"]) {
    super(`Language model failure: ${code}`);
    this.name = "ModelProviderError";
    this.code = code;
  }
}

/** Text and explicitly approved context only; audio/authentication never enter this provider. */
export class OpenAIResponsesProvider implements LanguageModelProvider {
  readonly id = "openai";
  private readonly options: { apiKey: string; model: string; timeoutMs: number; maxOutputTokens: number };
  private readonly fetcher: typeof fetch;

  constructor(
    options: { apiKey: string; model: string; timeoutMs: number; maxOutputTokens: number },
    fetcher: typeof fetch = fetch,
  ) { this.options = options; this.fetcher = fetcher; }

  async generate(request: LanguageModelRequest): Promise<LanguageModelResponse> {
    if (!this.options.apiKey) throw new ModelProviderError("configuration");
    let response: Response;
    try {
      response = await this.fetcher("https://api.openai.com/v1/responses", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          instructions: request.system,
          input: [...request.messages, ...(request.continuation ?? [])],
          store: false,
          include: ["reasoning.encrypted_content"],
          max_output_tokens: this.options.maxOutputTokens,
          ...(request.tools?.length ? { tools: request.tools, parallel_tool_calls: false } : {}),
          ...(request.responseFormat === "json" ? { text: { format: { type: "json_object" } } } : {}),
        }),
      });
    } catch (error) {
      throw new ModelProviderError(error instanceof Error && /Timeout|Abort/.test(error.name) ? "timeout" : "unavailable");
    }
    if (!response.ok) {
      // Provider error bodies can echo submitted text or credentials; never log/return them.
      await response.body?.cancel();
      throw new ModelProviderError(response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate_limit" : "unavailable");
    }
    let payload: Record<string, unknown>;
    try { payload = await response.json(); } catch { throw new ModelProviderError("invalid_response"); }
    if (!payload || typeof payload !== "object" || payload.status !== "completed" || !Array.isArray(payload.output)) {
      throw new ModelProviderError("invalid_response");
    }
    const output = payload.output.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
    const text = output.filter((item) => item.type === "message" && Array.isArray(item.content))
      .flatMap((item) => item.content as Array<Record<string, unknown>>)
      .filter((item) => item && typeof item === "object" && item.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text as string).join("\n").trim();
    const toolCalls = output.filter((item) => item.type === "function_call").map((item) => {
      if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string" || item.arguments.length > 4_000) {
        throw new ModelProviderError("invalid_response");
      }
      return { callId: item.call_id, name: item.name, arguments: item.arguments };
    });
    if ((!text && !toolCalls.length) || toolCalls.length > 1) throw new ModelProviderError("invalid_response");
    return { text, model: typeof payload.model === "string" ? payload.model : this.options.model, output, toolCalls };
  }
}
