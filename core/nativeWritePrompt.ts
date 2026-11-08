import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PermissionChallenge } from "./permissions.ts";

const execFileAsync = promisify(execFile);

/**
 * Shows a Windows MessageBox owned by the Next process (which holds the launcher
 * event token). Browser loopback clicks are not a trusted write channel.
 */
export async function promptNativeWriteApproval(challenge: PermissionChallenge): Promise<boolean> {
  if (process.platform !== "win32") return false;

  const title = "Ultron write approval";
  const body = [
    "Ultron is requesting a write action.",
    "",
    `Tool: ${challenge.toolName}`,
    `Risk: ${challenge.risk}`,
    `Scope: ${challenge.scope}`,
    challenge.description,
    "",
    "Allow this action?",
  ].join("\n");

  // Escape for a single-quoted PowerShell string.
  const psTitle = title.replace(/'/g, "''");
  const psBody = body.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName PresentationFramework;",
    `$result = [System.Windows.MessageBox]::Show('${psBody}', '${psTitle}', 'YesNo', 'Warning');`,
    "if ($result -eq 'Yes') { exit 0 } else { exit 1 }",
  ].join(" ");

  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: false, timeout: 5 * 60 * 1000 },
    );
    return true;
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 1) return false;
    return false;
  }
}
