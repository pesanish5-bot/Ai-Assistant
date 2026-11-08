import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceOutlineTool } from "../core/integrations/workspace.ts";

test("workspace outline is bounded to approved source names and skips private content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ultron-workspace-test-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, ".ultron"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "src", "main.ts"), "export const value = 1;");
    await writeFile(path.join(root, ".env.local"), "PRIVATE_TEST_VALUE");
    await writeFile(path.join(root, ".ultron", "state.json"), "PRIVATE_TEST_VALUE");
    await writeFile(path.join(root, "node_modules", "package.js"), "generated");
    const tool = createWorkspaceOutlineTool(root);
    const result = await tool.execute({ workspace: "ultron" }, { requestId: "test", logger: {} as never });
    assert.deepEqual(result.files, ["src/main.ts"]);
    assert.deepEqual(result.directories, ["src"]);
    assert.equal(JSON.stringify(result).includes("PRIVATE_TEST_VALUE"), false);
    await assert.rejects(tool.execute({ workspace: "elsewhere" } as never, { requestId: "test", logger: {} as never }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
