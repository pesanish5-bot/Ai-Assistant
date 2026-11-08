import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "../tools.ts";

const runFile = promisify(execFile);

export interface DesktopAppInventory {
  applications: string[];
  truncated: boolean;
}

async function listVisibleApplications(): Promise<string[]> {
  if (process.platform !== "win32") throw new Error("Desktop app inspection requires Windows.");
  try {
    const { stdout } = await runFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.ProcessName }",
    ], { timeout: 10_000, maxBuffer: 262_144, windowsHide: true });
    return stdout.split(/\r?\n/u).map((name) => name.trim()).filter(Boolean);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`Desktop app inspection is temporarily unavailable (${typeof code === "string" ? code : "unknown"}).`);
  }
}

/** Fixed read-only observation; never accepts a command, path, click, or title. */
export function createDesktopAppsTool(
  inspect: () => Promise<string[]> = listVisibleApplications,
): ToolDefinition<{ target: "desktop" }, DesktopAppInventory> {
  return {
    name: "computer.desktop.apps",
    description: "List only the names of currently visible Windows applications. No window titles or contents are read.",
    risk: "read",
    permissionScope: "computer:desktop:apps",
    async execute(input): Promise<DesktopAppInventory> {
      if (input?.target !== "desktop" || Object.keys(input).length !== 1) {
        throw new Error("Only the local desktop app inventory can be inspected.");
      }
      const applications = [...new Set((await inspect())
        .filter((name) => /^[\p{L}\p{N}_.-]{1,100}$/u.test(name)))]
        .sort((a, b) => a.localeCompare(b));
      return { applications: applications.slice(0, 30), truncated: applications.length > 30 };
    },
  };
}
