import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../core/config.ts";
import { ConversationMemory } from "../core/conversationMemory.ts";
import { GeminiGenerateProvider, ModelProviderError, OpenAIResponsesProvider, type LanguageModelProvider, type LanguageModelRequest } from "../core/llm.ts";
import { UltronRuntime } from "../core/runtime.ts";
import { MarkdownVault } from "../core/vault.ts";
import { MemoryLogger } from "../core/observability.ts";
import { MemoryPermissionGrantStore, PermissionService } from "../core/permissions.ts";

const options = { apiKey: "test-only-secret", model: "gpt-6-sol", timeoutMs: 1_000, maxOutputTokens: 500 };
const prompt: LanguageModelRequest = { system: "test", messages: [{ role: "user", content: "hello" }] };

test("Responses provider sends stateless text, and parses visible output without reasoning", async () => {
  const provider = new OpenAIResponsesProvider(options, (async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.deepEqual(body.input, prompt.messages);
    assert.equal(body.max_output_tokens, 500);
    return Response.json({ status: "completed", output: [
      { type: "reasoning", encrypted_content: "never-visible" },
      { type: "message", content: [null, { type: "output_text", text: "Hello" }] },
    ] });
  }) as typeof fetch);
  assert.equal((await provider.generate(prompt)).text, "Hello");
});

test("Gemini provider sends the key as a header and parses text or one tool call", async () => {
  const provider = new GeminiGenerateProvider(
    { apiKey: "test-gemini-key", model: "gemini-2.5-flash", timeoutMs: 1_000, maxOutputTokens: 500 },
    (async (url, init) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-goog-api-key"), "test-gemini-key");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.contents[0].role, "user");
      assert.equal(body.contents[0].parts[0].text, "hello");
      return Response.json({ candidates: [{ content: { parts: [{ text: "Hello from Gemini" }] } }] });
    }) as typeof fetch,
  );
  assert.equal((await provider.generate(prompt)).text, "Hello from Gemini");

  const toolProvider = new GeminiGenerateProvider(
    { apiKey: "test-gemini-key", model: "gemini-2.5-flash", timeoutMs: 1_000, maxOutputTokens: 500 },
    (async () => Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: "search_vault", args: { query: "sample" } } }] } }] })) as typeof fetch,
  );
  const tool = await toolProvider.generate(prompt);
  assert.equal(tool.toolCalls?.[0]?.name, "search_vault");
  assert.equal(tool.toolCalls?.[0]?.arguments, "{\"query\":\"sample\"}");
});

test("Gemini returns a function-call thought signature unchanged with the tool result", async () => {
  let calls = 0;
  const provider = new GeminiGenerateProvider(
    { apiKey: "test-gemini-key", model: "gemini-3.8-flash", timeoutMs: 1_000, maxOutputTokens: 500 },
    (async (_url, init) => {
      calls++;
      if (calls === 1) return Response.json({ candidates: [{ content: { parts: [{
        functionCall: { name: "search_vault", args: { query: "sample" } },
        thoughtSignature: "opaque-signature",
      }] } }] });
      const contents = JSON.parse(String(init?.body)).contents;
      assert.deepEqual(contents.at(-2).parts, [{
        functionCall: { name: "search_vault", args: { query: "sample" } },
        thoughtSignature: "opaque-signature",
      }]);
      assert.deepEqual(contents.at(-1).parts, [{
        functionResponse: { name: "search_vault", response: { results: [] } },
      }]);
      return Response.json({ candidates: [{ content: { parts: [{ text: "No matches." }] } }] });
    }) as typeof fetch,
  );
  const first = await provider.generate(prompt);
  assert.equal(first.output?.[0].thoughtSignature, "opaque-signature");
  const second = await provider.generate({
    ...prompt,
    continuation: [
      ...(first.output ?? []),
      { type: "function_call_output", call_id: first.toolCalls?.[0].callId, output: '{"results":[]}' },
    ],
  });
  assert.equal(second.text, "No matches.");
});

test("Gemini tool declarations omit unsupported additionalProperties without mutating the tool", async () => {
  const parameters = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
  const provider = new GeminiGenerateProvider(
    { apiKey: "test-gemini-key", model: "gemini-3.8-flash", timeoutMs: 1_000, maxOutputTokens: 500 },
    (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.tools[0].functionDeclarations[0].parameters, {
        type: "object", properties: { query: { type: "string" } }, required: ["query"],
      });
      return Response.json({ candidates: [{ content: { parts: [{ text: "READY" }] } }] });
    }) as typeof fetch,
  );
  await provider.generate({ ...prompt, tools: [{ type: "function", name: "search_vault", description: "Search", strict: true, parameters }] });
  assert.equal(parameters.additionalProperties, false);
});

test("provider errors fail safely without returning upstream error bodies", async () => {
  for (const [status, code] of [[401, "authentication"], [429, "rate_limit"], [500, "unavailable"]] as const) {
    const provider = new OpenAIResponsesProvider(options, (async () => new Response("sensitive submitted data", { status })) as typeof fetch);
    await assert.rejects(provider.generate(prompt), (error: unknown) => error instanceof ModelProviderError && error.code === code && !error.message.includes("sensitive"));
  }
  for (const payload of [null, {}, { status: "incomplete", output: [] }, { status: "completed", output: [] }]) {
    const provider = new OpenAIResponsesProvider(options, (async () => Response.json(payload)) as typeof fetch);
    await assert.rejects(provider.generate(prompt), (error: unknown) => error instanceof ModelProviderError && error.code === "invalid_response");
  }
  const provider = new OpenAIResponsesProvider(options, (async () => { throw new DOMException("secret", "TimeoutError"); }) as typeof fetch);
  await assert.rejects(provider.generate(prompt), (error: unknown) => error instanceof ModelProviderError && error.code === "timeout");
  const overloaded = new GeminiGenerateProvider(
    { ...options, model: "gemini-3.8-flash" },
    (async () => new Response("upstream details", { status: 503 })) as typeof fetch,
  );
  await assert.rejects(overloaded.generate(prompt), (error: unknown) => error instanceof ModelProviderError && error.code === "unavailable" && !error.message.includes("upstream"));
});

test("working memory is bounded, session-isolated, ephemeral and separates local text from cloud context", () => {
  let now = 0;
  const memory = new ConversationMemory(() => now, 100);
  memory.add("a", "user", "local private note", "voice");
  assert.deepEqual(memory.history("a"), []);
  assert.equal(memory.snapshot("a").messages[0].source, "voice");
  assert.equal("cloudEligible" in memory.snapshot("a").messages[0], false);
  memory.approveForCloud("a");
  assert.equal(memory.history("a").length, 1);
  assert.deepEqual(memory.snapshot("b").messages, []);
  for (let index = 0; index < 40; index++) memory.add("a", "assistant", "x".repeat(2_000), "text");
  assert.ok(memory.snapshot("a").messages.length <= 16);
  assert.equal(memory.begin("a"), true);
  assert.equal(memory.begin("a"), false);
  assert.equal(memory.clear("a"), false);
  memory.finish("a");
  now = 101;
  assert.deepEqual(memory.snapshot("a").messages, []);
  assert.throws(() => memory.snapshot("../bad"));
});

async function fixture(provider?: LanguageModelProvider) {
  const directory = await mkdtemp(path.join(tmpdir(), "ultron-brain-test-"));
  const config = loadConfig({ ULTRON_DATA_DIR: directory, ULTRON_LLM_PROVIDER: "disabled" });
  const vault = new MarkdownVault(config.vaultDir);
  await vault.initialize();
  const logger = new MemoryLogger();
  const runtime = new UltronRuntime({ config, vault, logger, provider, permissions: new PermissionService(new MemoryPermissionGrantStore()) });
  return { runtime, vault, logger, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("conversation supports follow-up context and multilingual drafts without auto-saving", async () => {
  const requests: LanguageModelRequest[] = [];
  const fixtureData = await fixture({ id: "mock", async generate(request) { requests.push(request); return { text: "বাংলায় খসড়া", model: "mock" }; } });
  const { runtime, vault } = fixtureData;
  try {
    const first = await runtime.execute({ message: "Draft an email in Bengali", source: "voice" });
    assert.equal(first.status, "ok");
    if (first.status === "ok") assert.equal(first.output.skill, "conversation");
    await runtime.execute({ message: "Make that friendlier" });
    assert.deepEqual(requests[1].messages.map((item) => item.role), ["user", "assistant", "user"]);
    assert.equal(requests[0].tools, undefined);
    assert.equal(requests[1].tools, undefined);
    assert.match(requests[0].system, /For spoken conversation/);
    assert.doesNotMatch(requests[1].system, /For spoken conversation/);
    assert.equal(runtime.conversation.snapshot("local").messages.length, 4);
    assert.equal(runtime.conversation.snapshot("local").messages[0].source, "voice");
    assert.equal((await vault.search({})).length, 0);
    assert.equal(runtime.clearConversation(), true);
    assert.deepEqual(runtime.conversation.snapshot("local").messages, []);
  } finally { await fixtureData.cleanup(); }
});

test("dictation and local skill results are not silently included in later cloud requests", async () => {
  const requests: LanguageModelRequest[] = [];
  const data = await fixture({ id: "mock", async generate(request) { requests.push(request); return { text: "Hello", model: "mock" }; } });
  try {
    const dictated = await data.runtime.execute({ message: "dictate:secret local text", source: "voice" });
    assert.equal(dictated.status, "ok");
    if (dictated.status === "ok") assert.equal(dictated.human, "secret local text");
    assert.equal(requests.length, 0);
    await data.runtime.execute({ message: "Hello friend" });
    assert.deepEqual(requests[0].messages, [{ role: "user", content: "Hello friend" }]);
  } finally { await data.cleanup(); }
});

test("missing API key and provider failure report limitations without fake actions", async () => {
  const data = await fixture();
  try {
    const result = await data.runtime.execute({ message: "Draft a WhatsApp reply" });
    assert.equal(result.status, "unsupported");
    assert.equal(data.runtime.brainStatus().configured, false);
    assert.equal(JSON.stringify(data.runtime.brainStatus()).includes("apiKey"), false);
    assert.throws(() => loadConfig({ ULTRON_LLM_PROVIDER: "unknown" }));
  } finally { await data.cleanup(); }
  const broken = await fixture({ id: "mock", async generate() { throw new ModelProviderError("rate_limit"); } });
  try { assert.equal((await broken.runtime.execute({ message: "Hello" })).status, "error"); }
  finally { await broken.cleanup(); }
});

test("project inspection requires approval and exposes only the current checkout outline", async () => {
  let calls = 0;
  let inspected = "";
  const data = await fixture({ id: "mock", async generate(request) {
    calls++;
    assert.equal(request.tools?.[0]?.name, "inspect_ultron_workspace");
    if (calls === 1) return {
      text: "", model: "mock",
      output: [{ type: "function_call", call_id: "workspace_call", name: "inspect_ultron_workspace", arguments: '{"workspace":"ultron"}' }],
      toolCalls: [{ callId: "workspace_call", name: "inspect_ultron_workspace", arguments: '{"workspace":"ultron"}' }],
    };
    inspected = JSON.stringify(request.continuation);
    return { text: "I inspected the approved Ultron source outline.", model: "mock" };
  } });
  try {
    const message = "Inspect this Ultron repository structure";
    const first = await data.runtime.execute({ message });
    assert.equal(first.status, "confirmation_required");
    assert.equal(inspected, "");
    if (first.status !== "confirmation_required") return;
    const second = await data.runtime.execute({ message, confirmationId: first.confirmation.id });
    assert.equal(second.status, "ok");
    assert.equal(calls, 2);
    assert.match(inspected, /README\.md/);
    assert.doesNotMatch(inspected, /\.env\.local|node_modules|PRIVATE_TEST_VALUE/);
  } finally { await data.cleanup(); }
});

test("desktop and Android inspection tools are offered only for matching requests and require approval", async () => {
  for (const scenario of [
    { message: "Which apps are open on my desktop?", tool: "list_visible_desktop_apps", args: '{"target":"desktop"}' },
    { message: "Is my Android phone connected for wireless debugging?", tool: "check_android_connection", args: '{"target":"android"}' },
  ]) {
    let invoked = 0;
    const data = await fixture({ id: "mock", async generate(request) {
      invoked++;
      assert.deepEqual(request.tools?.map((tool) => tool.name), [scenario.tool]);
      return {
        text: "", model: "mock",
        output: [{ type: "function_call", call_id: "observe", name: scenario.tool, arguments: scenario.args }],
        toolCalls: [{ callId: "observe", name: scenario.tool, arguments: scenario.args }],
      };
    } });
    try {
      const result = await data.runtime.execute({ message: scenario.message });
      assert.equal(result.status, "confirmation_required");
      assert.equal(invoked, 1);
    } finally { await data.cleanup(); }
  }
});

test("Vault sharing waits for approval, resumes the exact tool call and excludes private notes", async () => {
  let calls = 0;
  let sent = "";
  const data = await fixture({ id: "mock", async generate(request) {
    calls++;
    assert.equal(request.tools?.[0]?.name, "search_vault");
    if (calls === 1) return { text: "", model: "mock", output: [{ type: "function_call", call_id: "call_1", name: "search_vault", arguments: '{"query":"sample"}' }], toolCalls: [{ callId: "call_1", name: "search_vault", arguments: '{"query":"sample"}' }] };
    sent = JSON.stringify(request.continuation);
    return { text: "Your sample project is active.", model: "mock" };
  } });
  try {
    await data.vault.save({ namespace: "knowledge", kind: "project", title: "Sample project", data: { status: "active" } });
    await data.vault.save({ namespace: "knowledge", kind: "note", title: "Sample private", tags: ["no-cloud"], data: { text: "secret-note" } });
    const message = "Tell me about my saved sample project";
    const initial = await data.runtime.execute({ message });
    assert.equal(initial.status, "confirmation_required");
    assert.equal(sent, "");
    if (initial.status !== "confirmation_required") return;
    assert.equal(data.runtime.conversation.snapshot("local").pending?.id, initial.confirmation.id);
    const confirmed = await data.runtime.execute({ message, confirmationId: initial.confirmation.id });
    assert.equal(confirmed.status, "ok");
    assert.equal(calls, 2);
    assert.match(sent, /Sample project/);
    assert.doesNotMatch(sent, /secret-note|Sample private/);
    assert.equal(data.runtime.conversation.snapshot("local").pending, null);
  } finally { await data.cleanup(); }
});

test("unrecognized model tools cannot invoke actions or change the Vault", async () => {
  const data = await fixture({ id: "mock", async generate() { return { text: "", model: "mock", output: [], toolCalls: [{ callId: "bad", name: "send_email", arguments: "{}" }] }; } });
  try {
    assert.equal((await data.runtime.execute({ message: "Send an email" })).status, "error");
    assert.deepEqual(await data.vault.search({}), []);
  } finally { await data.cleanup(); }
});

test("denying a context request retains chat, rejects stale approval and shares nothing", async () => {
  let calls = 0;
  const data = await fixture({ id: "mock", async generate() {
    calls++;
    return { text: "", model: "mock", output: [], toolCalls: [{ callId: "read", name: "search_vault", arguments: '{"query":"sample"}' }] };
  } });
  try {
    const message = "Tell me about the saved sample project";
    const initial = await data.runtime.execute({ message });
    assert.equal(initial.status, "confirmation_required");
    if (initial.status !== "confirmation_required") return;
    assert.equal(data.runtime.cancelConfirmation(), true);
    assert.equal(data.runtime.conversation.snapshot("local").messages.length, 1);
    assert.equal(data.runtime.conversation.snapshot("local").pending, null);
    const stale = await data.runtime.execute({ message, confirmationId: initial.confirmation.id });
    assert.equal(stale.status, "error");
    assert.equal(calls, 1);
  } finally { await data.cleanup(); }
});

test("malformed tool arguments fail closed and cannot bypass the context gate", async () => {
  const data = await fixture({ id: "mock", async generate() {
    return { text: "", model: "mock", output: [], toolCalls: [{ callId: "read", name: "search_vault", arguments: '{"query":"sample","extra":"secret"}' }] };
  } });
  try {
    assert.equal((await data.runtime.execute({ message: "Tell me about the saved sample project" })).status, "error");
    assert.equal(data.runtime.conversation.snapshot("local").pending, null);
  } finally { await data.cleanup(); }
});

test("overlapping voice and text requests cannot overwrite a pending turn", async () => {
  let release!: (value: { text: string; model: string }) => void;
  const answer = new Promise<{ text: string; model: string }>((resolve) => { release = resolve; });
  const data = await fixture({ id: "mock", async generate() { return answer; } });
  try {
    const first = data.runtime.execute({ message: "Hello", source: "voice" });
    const second = await data.runtime.execute({ message: "Other request", source: "text" });
    assert.equal(second.status, "error");
    assert.equal(data.runtime.clearConversation(), false);
    assert.equal(data.runtime.cancelConfirmation(), false);
    release({ text: "Hello back", model: "mock" });
    assert.equal((await first).status, "ok");
    assert.equal(data.runtime.conversation.snapshot("local").messages.length, 2);
  } finally { release({ text: "cleanup", model: "mock" }); await data.cleanup(); }
});
