export interface LanguageModelRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  responseFormat?: "text" | "json";
}

export interface LanguageModelResponse {
  text: string;
  model: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface LanguageModelProvider {
  readonly id: string;
  generate(request: LanguageModelRequest): Promise<LanguageModelResponse>;
}

// Provider selection is intentionally deferred until the local/cloud and model decision is made.
// Skills in the first foundation remain deterministic and do not pretend an LLM is configured.
