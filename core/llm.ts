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

interface GeminiPart {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function geminiParameters(schema: Record<string, unknown>): Record<string, unknown> {
  // Gemini's `parameters` schema does not accept additionalProperties. Ultron
  // still validates model-supplied arguments before invoking a local tool.
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => key !== "additionalProperties")
    .map(([key, value]) => {
      const record = asRecord(value);
      return [key, Array.isArray(value)
        ? value.map((item) => {
          const nested = asRecord(item);
          return nested ? geminiParameters(nested) : item;
        })
        : record ? geminiParameters(record) : value];
    }));
}

/** Text and approved tool results only. The key stays in the request header and is never logged. */
export class GeminiGenerateProvider implements LanguageModelProvider {
  readonly id = "gemini";
  private readonly options: { apiKey: string; model: string; timeoutMs: number; maxOutputTokens: number };
  private readonly fetcher: typeof fetch;

  constructor(
    options: { apiKey: string; model: string; timeoutMs: number; maxOutputTokens: number },
    fetcher: typeof fetch = fetch,
  ) { this.options = options; this.fetcher = fetcher; }

  async generate(request: LanguageModelRequest): Promise<LanguageModelResponse> {
    if (!this.options.apiKey) throw new ModelProviderError("configuration");
    const contents = geminiContents(request);
    if (contents.length === 0) throw new ModelProviderError("invalid_response");
    let response: Response;
    try {
      response = await this.fetcher(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(this.options.timeoutMs),
          headers: { "x-goog-api-key": this.options.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents,
            generationConfig: {
              maxOutputTokens: this.options.maxOutputTokens,
              ...(request.responseFormat === "json" ? { responseMimeType: "application/json" } : {}),
            },
            ...(request.tools?.length ? {
              tools: [{
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: geminiParameters(tool.parameters),
                })),
              }],
            } : {}),
          }),
        },
      );
    } catch (error) {
      throw new ModelProviderError(error instanceof Error && /Timeout|Abort/.test(error.name) ? "timeout" : "unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelProviderError(response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate_limit" : "unavailable");
    }
    let payload: Record<string, unknown>;
    try { payload = await response.json(); } catch { throw new ModelProviderError("invalid_response"); }
    return parseGeminiResponse(payload, this.options.model);
  }
}

function geminiContents(request: LanguageModelRequest): Array<{ role: "user" | "model"; parts: GeminiPart[] }> {
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
  const push = (role: "user" | "model", parts: GeminiPart[]) => {
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts: [...parts] });
  };
  for (const message of request.messages) {
    if (!message.content.trim()) continue;
    push(message.role === "assistant" ? "model" : "user", [{ text: message.content }]);
  }
  const names = new Map<string, string>();
  for (const item of request.continuation ?? []) {
    if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string" && typeof item.arguments === "string") {
      names.set(item.call_id, item.name);
      let args: unknown = {};
      try { args = JSON.parse(item.arguments); } catch { args = {}; }
      push("model", [{
        functionCall: { name: item.name, args: asRecord(args) ?? {} },
        ...(typeof item.thoughtSignature === "string" ? { thoughtSignature: item.thoughtSignature } : {}),
      }]);
    } else if (item.type === "function_call_output" && typeof item.call_id === "string") {
      const name = names.get(item.call_id);
      if (!name) throw new ModelProviderError("invalid_response");
      let parsed: unknown = item.output;
      if (typeof parsed === "string") {
        try { parsed = JSON.parse(parsed); } catch { parsed = { result: parsed }; }
      }
      push("user", [{ functionResponse: { name, response: asRecord(parsed) ?? { result: parsed } } }]);
    }
  }
  return contents;
}

function parseGeminiResponse(payload: Record<string, unknown>, fallbackModel: string): LanguageModelResponse {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const content = asRecord(asRecord(candidates[0])?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  const output: Record<string, unknown>[] = [];
  for (const value of parts) {
    const part = asRecord(value);
    if (!part) continue;
    if (typeof part.text === "string" && part.text.trim()) text.push(part.text.trim());
    const call = asRecord(part.functionCall);
    if (call && typeof call.name === "string") {
      const args = JSON.stringify(asRecord(call.args) ?? {});
      if (args.length > 4_000) throw new ModelProviderError("invalid_response");
      const callId = `gemini-${toolCalls.length}-${call.name}`;
      toolCalls.push({ callId, name: call.name, arguments: args });
      output.push({
        type: "function_call", call_id: callId, name: call.name, arguments: args,
        ...(typeof part.thoughtSignature === "string" ? { thoughtSignature: part.thoughtSignature } : {}),
      });
    }
  }
  if ((!text.length && !toolCalls.length) || toolCalls.length > 1) throw new ModelProviderError("invalid_response");
  return { text: text.join("\n"), model: fallbackModel, output, toolCalls };
}
