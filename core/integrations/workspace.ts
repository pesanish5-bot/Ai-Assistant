import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../tools.ts";

const SKIP_DIRECTORIES = new Set([
  ".git", ".next", ".ultron", ".venv", "node_modules", "vault", "build", "dist", "out", "__pycache__",
]);

export interface WorkspaceOutline {
  workspace: "ultron";
  files: string[];
  directories: string[];
  truncated: boolean;
}

/** Read only the approved checkout's shallow, non-secret directory outline. */
export function createWorkspaceOutlineTool(root: string): ToolDefinition<{ workspace: "ultron" }, WorkspaceOutline> {
  return {
    name: "computer.workspace.inspect",
    description: "Inspect the ULTRON source tree, excluding hidden, private, generated, and dependency files.",
    risk: "read",
    permissionScope: "computer:ultron:inspect",
    async execute(input): Promise<WorkspaceOutline> {
      if (input?.workspace !== "ultron") throw new Error("Only the approved ULTRON workspace can be inspected.");
      const approvedRoot = await realpath(root);
      const files: string[] = [];
      const directories: string[] = [];
      const pending = [{ absolute: approvedRoot, relative: "", depth: 0 }];
      const maxEntries = 200;
      let truncated = false;
      while (pending.length && files.length + directories.length < maxEntries) {
        const current = pending.shift()!;
        const entries = (await readdir(current.absolute, { withFileTypes: true }))
          .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (files.length + directories.length >= maxEntries) { truncated = true; break; }
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          const relative = path.posix.join(current.relative, entry.name);
          if (entry.isDirectory()) {
            if (SKIP_DIRECTORIES.has(entry.name)) continue;
            directories.push(relative);
            if (current.depth < 2) pending.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
          } else if (entry.isFile() && !/\.(?:pem|key|p12|pfx|log)$/i.test(entry.name)) {
            files.push(relative);
          }
        }
      }
      return { workspace: "ultron", files, directories, truncated: truncated || pending.length > 0 };
    },
  };
}
