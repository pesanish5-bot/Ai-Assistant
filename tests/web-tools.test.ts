import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicHttpsUrl,
  assertResolvesToPublicAddress,
  createWebFetchTool,
  createWebSearchTool,
  isBlockedIpAddress,
} from "../core/integrations/web.ts";
import { MemoryLogger } from "../core/observability.ts";
import { MemoryPermissionGrantStore, PermissionRequiredError, PermissionService } from "../core/permissions.ts";
import { ToolRegistry } from "../core/tools.ts";

test("SSRF helpers block private and loopback addresses", () => {
  for (const address of ["127.0.0.1", "10.0.0.2", "192.168.1.1", "169.254.1.1", "172.16.5.5", "::1", "fc00::1"]) {
    assert.equal(isBlockedIpAddress(address), true, address);
  }
  assert.equal(isBlockedIpAddress("1.1.1.1"), false);
  assert.throws(() => assertPublicHttpsUrl("http://example.com"), /https/);
  assert.throws(() => assertPublicHttpsUrl("https://127.0.0.1/"), /Private|local/i);
  assert.throws(() => assertPublicHttpsUrl("https://user:pass@example.com/"), /credentials/);
});

test("hostname resolution rejects private DNS answers", async () => {
  await assert.rejects(
    () => assertResolvesToPublicAddress("evil.example", async () => "10.1.2.3"),
    /private or local/i,
  );
  assert.equal(await assertResolvesToPublicAddress("ok.example", async () => "8.8.8.8"), "8.8.8.8");
});

test("web.search requires approval, drops unsafe result URLs, and marks output untrusted", async () => {
  const tools = new ToolRegistry(new PermissionService(new MemoryPermissionGrantStore()), new MemoryLogger());
  tools.register(createWebSearchTool("brave-test-key", (async (url, init) => {
    assert.match(String(url), /api\.search\.brave\.com/);
    assert.equal(new Headers(init?.headers).get("x-subscription-token"), "brave-test-key");
    return Response.json({
      web: {
        results: [
          { title: "Match schedule", url: "https://example.com/match", description: "Kickoff Friday" },
          { title: "Internal", url: "http://127.0.0.1/secret", description: "blocked" },
        ],
      },
    });
  }) as typeof fetch));

  const request = { requestId: "r1", message: "When is the next football match?" };
  let challenge = "";
  await assert.rejects(
    () => tools.invoke("web.search", { query: "next football match" }, request),
    (error: unknown) => {
      assert.ok(error instanceof PermissionRequiredError);
      challenge = error.challenge.id;
      return true;
    },
  );

  const output = await tools.invoke(
    "web.search",
    { query: "next football match" },
    { ...request, confirmationId: challenge },
  ) as { results: Array<{ url: string; title: string }>; untrusted: true; notice: string };
  assert.equal(output.untrusted, true);
  assert.match(output.notice, /UNTRUSTED_WEB_DATA/);
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].url, "https://example.com/match");
  assert.equal(output.results[0].title, "Match schedule");
});

test("web.fetch follows safe redirects, blocks private redirects, and extracts text", async () => {
  const tools = new ToolRegistry(new PermissionService(new MemoryPermissionGrantStore()), new MemoryLogger());
  let hop = 0;
  tools.register(createWebFetchTool((async (url) => {
    hop += 1;
    if (hop === 1) {
      assert.equal(String(url), "https://example.com/start");
      return new Response(null, { status: 302, headers: { Location: "https://example.com/next" } });
    }
    return new Response(`<title>Ok</title><p>${"word ".repeat(5)}</p>`, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }) as typeof fetch, async () => "93.184.216.34"));

  const request = { requestId: "f1", message: "Fetch https://example.com/start please" };
  let challenge = "";
  await assert.rejects(
    () => tools.invoke("web.fetch", { url: "https://example.com/start" }, request),
    (error: unknown) => {
      assert.ok(error instanceof PermissionRequiredError);
      challenge = error.challenge.id;
      return true;
    },
  );
  const page = await tools.invoke(
    "web.fetch",
    { url: "https://example.com/start" },
    { ...request, confirmationId: challenge },
  ) as { title: string; text: string; untrusted: true; finalUrl: string };
  assert.equal(page.title, "Ok");
  assert.match(page.text, /word/);
  assert.equal(page.untrusted, true);
  assert.equal(page.finalUrl, "https://example.com/next");

  const blocked = new ToolRegistry(new PermissionService(new MemoryPermissionGrantStore()), new MemoryLogger());
  blocked.register(createWebFetchTool((async () => new Response(null, {
    status: 302,
    headers: { Location: "https://169.254.169.254/latest/meta-data/" },
  })) as typeof fetch, async () => "1.2.3.4"));
  const blockedRequest = { requestId: "b1", message: "open https://example.com/x" };
  let blockedId = "";
  await assert.rejects(
    () => blocked.invoke("web.fetch", { url: "https://example.com/x" }, blockedRequest),
    (error: unknown) => {
      assert.ok(error instanceof PermissionRequiredError);
      blockedId = error.challenge.id;
      return true;
    },
  );
  await assert.rejects(
    () => blocked.invoke("web.fetch", { url: "https://example.com/x" }, { ...blockedRequest, confirmationId: blockedId }),
    /Private|local|https|credentials|Redirect|Hostname/i,
  );
});

test("web.search without an API key fails closed after approval", async () => {
  const tools = new ToolRegistry(new PermissionService(new MemoryPermissionGrantStore()), new MemoryLogger());
  tools.register(createWebSearchTool(undefined));
  const request = { requestId: "k1", message: "search the web for scores" };
  let challenge = "";
  await assert.rejects(
    () => tools.invoke("web.search", { query: "scores" }, request),
    (error: unknown) => {
      assert.ok(error instanceof PermissionRequiredError);
      challenge = error.challenge.id;
      return true;
    },
  );
  await assert.rejects(
    () => tools.invoke("web.search", { query: "scores" }, { ...request, confirmationId: challenge }),
    /BRAVE_SEARCH_API_KEY/,
  );
});
