import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopAppsTool } from "../core/integrations/desktop.ts";
import { createAndroidStatusTool, parseAdbDevices } from "../core/integrations/android.ts";
import { MemoryLogger } from "../core/observability.ts";
import { MemoryPermissionGrantStore, PermissionRequiredError, PermissionService } from "../core/permissions.ts";
import { ToolRegistry } from "../core/tools.ts";

test("desktop observation exposes only bounded app names after approval", async () => {
  let observed = 0;
  const tools = new ToolRegistry(new PermissionService(new MemoryPermissionGrantStore()), new MemoryLogger());
  tools.register(createDesktopAppsTool(async () => {
    observed++;
    return ["Cursor", "Brave", "Cursor", "private window title", ...Array.from({ length: 40 }, (_, i) => `App${i}`)];
  }));
  const request = { requestId: "test", message: "Which apps are open?" };
  let challenge = "";
  await assert.rejects(tools.invoke("computer.desktop.apps", { target: "desktop" }, request), (error) => {
    assert.ok(error instanceof PermissionRequiredError);
    challenge = error.challenge.id;
    return true;
  });
  assert.equal(observed, 0);
  const result = await tools.invoke<{ target: "desktop" }, { applications: string[]; truncated: boolean }>(
    "computer.desktop.apps", { target: "desktop" }, { ...request, confirmationId: challenge },
  );
  assert.equal(observed, 1);
  assert.equal(result.applications.length, 30);
  assert.equal(result.truncated, true);
  assert.ok(result.applications.includes("App0"));
  assert.equal(JSON.stringify(result).includes("private window title"), false);
});

test("Android status redacts serials and never pairs, installs, or runs shell", async () => {
  const parsed = parseAdbDevices("List of devices attached\nPRIVATE_SERIAL_1 device\nPRIVATE_SERIAL_2 unauthorized\nPRIVATE_SERIAL_3 offline\n");
  assert.deepEqual(parsed, { adbAvailable: true, connected: 1, unauthorized: 1, offline: 1 });
  assert.equal(JSON.stringify(parsed).includes("PRIVATE_SERIAL"), false);
  const tool = createAndroidStatusTool(async () => parsed);
  assert.equal(tool.name, "android.devices.status");
  assert.equal(tool.risk, "read");
  assert.deepEqual(await tool.execute({ target: "android" }, { requestId: "test", logger: {} as never }), parsed);
  await assert.rejects(tool.execute({ target: "desktop" } as never, { requestId: "test", logger: {} as never }));
});
