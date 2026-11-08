import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function activationControlPath(): string {
  return join(process.cwd(), ".ultron", "runtime", "activation-control.json");
}

/** A missing setting preserves existing installs; a damaged setting fails quiet. */
export function readActivationEnabled(path = activationControlPath()): boolean {
  try {
    // This is private runtime state, not a build-time asset to trace into the server bundle.
    const value: unknown = JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8"));
    if (typeof value !== "object" || value === null || !("enabled" in value)) return false;
    return value.enabled === true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    return false;
  }
}

export function writeActivationEnabled(enabled: boolean, path = activationControlPath()): void {
  if (typeof enabled !== "boolean") throw new TypeError("Activation must be on or off.");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ enabled }), { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
