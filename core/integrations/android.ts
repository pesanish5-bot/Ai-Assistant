import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "../tools.ts";

const runFile = promisify(execFile);

export interface AndroidDeviceStatus {
  adbAvailable: boolean;
  connected: number;
  unauthorized: number;
  offline: number;
}

async function adbExecutable(): Promise<string | null> {
  const configured = process.env.ULTRON_ADB_PATH;
  if (configured) {
    if (!path.isAbsolute(configured) || path.basename(configured).toLowerCase() !== "adb.exe") {
      throw new Error("Configured ADB path must be an absolute adb.exe path.");
    }
    try { await access(configured); return configured; } catch { return null; }
  }
  const roots = [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk")];
  for (const root of roots) {
    if (!root) continue;
    const executable = path.join(root, "platform-tools", "adb.exe");
    try { await access(executable); return executable; } catch { /* Try the next known SDK location. */ }
  }
  return null; // Never execute an unreviewed adb.exe found through PATH or the working directory.
}

export function parseAdbDevices(output: string): AndroidDeviceStatus {
  const result: AndroidDeviceStatus = { adbAvailable: true, connected: 0, unauthorized: 0, offline: 0 };
  for (const line of output.split(/\r?\n/u).slice(0, 128)) {
    const match = /^\S+\s+(device|unauthorized|offline)(?:\s|$)/u.exec(line.trim());
    if (match?.[1] === "device") result.connected++;
    if (match?.[1] === "unauthorized") result.unauthorized++;
    if (match?.[1] === "offline") result.offline++;
  }
  return result; // Device serials and pairing codes never enter model context.
}

async function inspectAndroidDevices(): Promise<AndroidDeviceStatus> {
  try {
    const executable = await adbExecutable();
    if (!executable) return { adbAvailable: false, connected: 0, unauthorized: 0, offline: 0 };
    const { stdout } = await runFile(executable, ["devices"], {
      timeout: 4_000, maxBuffer: 16_384, windowsHide: true,
    });
    return parseAdbDevices(stdout);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { adbAvailable: false, connected: 0, unauthorized: 0, offline: 0 };
    }
    throw new Error("Android device inspection is temporarily unavailable.");
  }
}

/** Reads ADB connection status only; pairing, shell, install, and launch are absent. */
export function createAndroidStatusTool(
  inspect: () => Promise<AndroidDeviceStatus> = inspectAndroidDevices,
): ToolDefinition<{ target: "android" }, AndroidDeviceStatus> {
  return {
    name: "android.devices.status",
    description: "Check whether official Android ADB tooling is available and count authorized, unauthorized, and offline devices without revealing device IDs.",
    risk: "read",
    permissionScope: "android:devices:status",
    async execute(input): Promise<AndroidDeviceStatus> {
      if (input?.target !== "android" || Object.keys(input).length !== 1) {
        throw new Error("Only Android device status can be inspected.");
      }
      return inspect();
    },
  };
}
