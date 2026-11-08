import assert from "node:assert/strict";
import test from "node:test";
import {
  assertYouTubeWatchUrl,
  buildMediaSearchUrl,
  createAppOpenTool,
  createMediaAnalyzeTool,
  createMediaPlayTool,
  createTextTypeTool,
  createWindowFocusTool,
  escapeSendKeys,
} from "../core/integrations/computerActions.ts";
import { parseComputerAllowlist } from "../core/integrations/allowlist.ts";
import { MemoryLogger } from "../core/observability.ts";
import { MemoryPermissionGrantStore, PermissionRequiredError, PermissionService } from "../core/permissions.ts";
import { ToolRegistry } from "../core/tools.ts";

const allowlist = parseComputerAllowlist({
  apps: [
    {
      id: "notepad",
      label: "Notepad",
      path: "C:\\Windows\\System32\\notepad.exe",
      processName: "notepad",
    },
  ],
  mediaProviders: ["youtube", "spotify"],
  androidPackages: [],
});

test("allowlist parser rejects relative paths and odd process names", () => {
  const parsed = parseComputerAllowlist({
    apps: [
      { id: "bad", label: "Bad", path: "notepad.exe", processName: "notepad" },
      { id: "ok", label: "Ok", path: "C:\\Windows\\System32\\notepad.exe", processName: "notepad" },
    ],
    mediaProviders: ["youtube", "evil"],
  });
  assert.equal(parsed.apps.length, 1);
  assert.equal(parsed.apps[0].id, "ok");
  assert.deepEqual(parsed.mediaProviders, ["youtube"]);
});

test("media search URLs come only from fixed templates", () => {
  assert.equal(
    buildMediaSearchUrl("youtube", "Numb Linkin Park"),
    "https://www.youtube.com/results?search_query=Numb%20Linkin%20Park",
  );
  assert.match(buildMediaSearchUrl("spotify", "Numb"), /^https:\/\/open\.spotify\.com\/search\//);
  assert.throws(() => buildMediaSearchUrl("youtube", ""), /1–200/);
  assert.throws(() => assertYouTubeWatchUrl("https://example.com/watch?v=x"), /Only YouTube/);
  assert.doesNotThrow(() => assertYouTubeWatchUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
});

test("SendKeys escaping neutralizes chord characters", () => {
  assert.equal(escapeSendKeys("a+b^c%"), "a{+}b{^}c{%}");
});

test("computer write tools require permission and honor allowlist validators", async () => {
  const tools = new ToolRegistry(
    new PermissionService(new MemoryPermissionGrantStore(), 60_000, { enableTrustedWrites: true }),
    new MemoryLogger(),
  );
  const calls: string[] = [];
  const run = async (file: string, args: string[]) => {
    calls.push(`${file} ${args.join(" ")}`);
    return { stdout: "", stderr: "" };
  };
  const load = async () => allowlist;
  tools.register(createAppOpenTool(".ultron", { loadAllowlist: load, run }));
  tools.register(createMediaPlayTool(".ultron", { loadAllowlist: load, run }));
  tools.register(createWindowFocusTool(".ultron", { loadAllowlist: load, run }));
  tools.register(createTextTypeTool({ run }));
  tools.register(createMediaAnalyzeTool({
    fetchPage: async () => ({
      finalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      body: "<title>Demo</title><meta name=\"description\" content=\"Hello world\">",
    }),
  }));

  const request = { requestId: "t", message: "Open notepad" };
  await assert.rejects(tools.invoke("computer.app.open", { appId: "notepad" }, request), PermissionRequiredError);

  let challenge = "";
  await assert.rejects(tools.invoke("computer.app.open", { appId: "chrome" }, request), (error) => {
    assert.ok(error instanceof PermissionRequiredError);
    challenge = error.challenge.id;
    return true;
  });
  // Unknown app fails inside execute after approval would be granted — create a fresh challenge path via require:
  const open = createAppOpenTool(".ultron", { loadAllowlist: load, run });
  await assert.rejects(open.execute({ appId: "chrome" }, { requestId: "t", logger: new MemoryLogger() }), /allowlist/);

  await assert.rejects(tools.invoke("computer.media.play", { provider: "youtube", query: "Numb" }, request), (error) => {
    assert.ok(error instanceof PermissionRequiredError);
    challenge = error.challenge.id;
    return /computer:media:play/.test(error.challenge.scope);
  });
  void challenge;

  const analyzed = await (async () => {
    let id = "";
    await assert.rejects(
      tools.invoke("computer.media.analyze", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, request),
      (error) => {
        assert.ok(error instanceof PermissionRequiredError);
        id = error.challenge.id;
        return true;
      },
    );
    return tools.invoke(
      "computer.media.analyze",
      { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      { ...request, confirmationId: id },
    );
  })();
  assert.equal((analyzed as { title: string }).title, "Demo");
  assert.equal((analyzed as { untrusted: boolean }).untrusted, true);
});

test("brain intent gates recognize computer-use phrases", async () => {
  const {
    needsOpenApp,
    needsMediaPlay,
    needsMediaAnalyze,
    needsTypeText,
    needsWindowFocus,
  } = await import("../core/brain.ts");
  assert.equal(needsOpenApp("Open notepad for me"), true);
  assert.equal(needsMediaPlay("Play Numb by Linkin Park on YouTube"), true);
  assert.equal(needsMediaAnalyze("Analyze this youtube video https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
  assert.equal(needsTypeText("Type this message into the window for me"), true);
  assert.equal(needsWindowFocus("Focus the notepad window"), true);
  assert.equal(needsOpenApp("What time is it"), false);
});
