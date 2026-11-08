import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "../tools.ts";
import {
  loadComputerAllowlist,
  resolveAndroidPackage,
  type ComputerAllowlist,
} from "./allowlist.ts";

const runFile = promisify(execFile);

export interface AndroidDeviceStatus {
  adbAvailable: boolean;
  connected: number;
  unauthorized: number;
  offline: number;
}

export interface AndroidBatteryStatus {
  adbAvailable: boolean;
  connected: number;
  levelPercent: number | null;
  charging: boolean | null;
  note: string;
}

export interface AndroidAppOpenResult {
  packageId: string;
  packageName: string;
  launched: true;
  note: string;
}

export type AndroidMediaAction = "play_pause" | "volume_up" | "volume_down";

export interface AndroidMediaKeyResult {
  action: AndroidMediaAction;
  keyCode: number;
  sent: true;
  note: string;
}

const MEDIA_KEY_CODES: Record<AndroidMediaAction, number> = {
  play_pause: 85,
  volume_up: 24,
  volume_down: 25,
};

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

export function parseBatteryDump(output: string): Pick<AndroidBatteryStatus, "levelPercent" | "charging"> {
  let levelPercent: number | null = null;
  let charging: boolean | null = null;
  for (const line of output.split(/\r?\n/u).slice(0, 200)) {
    const level = /^\s*level:\s*(\d{1,3})\s*$/i.exec(line);
    if (level) {
      const value = Number(level[1]);
      if (Number.isInteger(value) && value >= 0 && value <= 100) levelPercent = value;
    }
    const plugged = /^\s*plugged:\s*(\d+)\s*$/i.exec(line);
    if (plugged) charging = Number(plugged[1]) > 0;
    const status = /^\s*status:\s*(\d+)\s*$/i.exec(line);
    // Android BatteryManager.BATTERY_STATUS_CHARGING = 2, FULL = 5
    if (status && charging === null) {
      const code = Number(status[1]);
      if (code === 2 || code === 5) charging = true;
      if (code === 3 || code === 4) charging = false;
    }
  }
  return { levelPercent, charging };
}

type Runner = (file: string, args: string[], options?: object) => Promise<{ stdout: string; stderr: string }>;

async function defaultRunner(file: string, args: string[], options?: object): Promise<{ stdout: string; stderr: string }> {
  const result = await runFile(file, args, { encoding: "utf8", ...(options ?? {}) } as never);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function inspectAndroidDevices(runner: Runner = defaultRunner): Promise<AndroidDeviceStatus> {
  try {
    const executable = await adbExecutable();
    if (!executable) return { adbAvailable: false, connected: 0, unauthorized: 0, offline: 0 };
    const { stdout } = await runner(executable, ["devices"], {
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

async function requireSingleAuthorizedDevice(runner: Runner): Promise<string> {
  const status = await inspectAndroidDevices(runner);
  if (!status.adbAvailable) throw new Error("ADB is not configured. Set ULTRON_ADB_PATH to an absolute adb.exe path.");
  if (status.connected !== 1) {
    throw new Error(
      status.connected === 0
        ? "No authorized Android device is connected. Pair/authorize ADB while the phone is unlocked."
        : "Multiple authorized Android devices are connected. Disconnect extras so Ultron can target exactly one.",
    );
  }
  const executable = await adbExecutable();
  if (!executable) throw new Error("ADB became unavailable.");
  return executable;
}

/** Reads ADB connection status only; pairing, shell, install, and launch are absent from this tool. */
export function createAndroidStatusTool(
  inspect: () => Promise<AndroidDeviceStatus> = () => inspectAndroidDevices(),
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

export function createAndroidBatteryTool(
  deps: { run?: Runner } = {},
): ToolDefinition<{ target: "android" }, AndroidBatteryStatus> {
  const runner = deps.run ?? defaultRunner;
  return {
    name: "android.battery.status",
    description: "Read battery level and charging state via ADB dumpsys on one authorized unlocked device. Never reveals serials or notification contents.",
    risk: "read",
    permissionScope: "android:battery:status",
    async execute(input): Promise<AndroidBatteryStatus> {
      if (input?.target !== "android" || Object.keys(input).length !== 1) {
        throw new Error("Only Android battery status can be inspected.");
      }
      const status = await inspectAndroidDevices(runner);
      if (!status.adbAvailable || status.connected === 0) {
        return {
          adbAvailable: status.adbAvailable,
          connected: status.connected,
          levelPercent: null,
          charging: null,
          note: "Connect and authorize exactly one unlocked Android device over ADB first.",
        };
      }
      const executable = await requireSingleAuthorizedDevice(runner);
      const { stdout } = await runner(executable, ["shell", "dumpsys", "battery"], {
        timeout: 5_000, maxBuffer: 65_536, windowsHide: true,
      });
      const parsed = parseBatteryDump(stdout);
      return {
        adbAvailable: true,
        connected: 1,
        levelPercent: parsed.levelPercent,
        charging: parsed.charging,
        note: "Battery fields only. Notification contents are never read by this tool.",
      };
    },
  };
}

export function createAndroidAppOpenTool(
  dataDir: string,
  deps: {
    loadAllowlist?: () => Promise<ComputerAllowlist>;
    run?: Runner;
  } = {},
): ToolDefinition<{ packageId: string }, AndroidAppOpenResult> {
  const load = deps.loadAllowlist ?? (() => loadComputerAllowlist(dataDir));
  const runner = deps.run ?? defaultRunner;
  return {
    name: "android.app.open",
    description: "Open an allowlisted Android package via adb monkey on one unlocked authorized device after trusted confirmation. Cannot unlock the phone.",
    risk: "reversible_write",
    permissionScope: (input) => `android:app:open:${typeof input?.packageId === "string" ? input.packageId : "unknown"}`,
    async execute(input): Promise<AndroidAppOpenResult> {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1) {
        throw new Error("Malformed Android app open input.");
      }
      const packageId = typeof input.packageId === "string" ? input.packageId.trim() : "";
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(packageId)) throw new Error("Malformed package id.");
      const entry = resolveAndroidPackage(await load(), packageId);
      const executable = await requireSingleAuthorizedDevice(runner);
      await runner(executable, ["shell", "monkey", "-p", entry.package, "-c", "android.intent.category.LAUNCHER", "1"], {
        timeout: 8_000, maxBuffer: 65_536, windowsHide: true,
      });
      return {
        packageId: entry.id,
        packageName: entry.package,
        launched: true,
        note: "Works only while the phone is unlocked and ADB-authorized. Ultron cannot bypass the lock screen.",
      };
    },
  };
}

export function createAndroidMediaKeyTool(
  deps: { run?: Runner } = {},
): ToolDefinition<{ action: AndroidMediaAction }, AndroidMediaKeyResult> {
  const runner = deps.run ?? defaultRunner;
  return {
    name: "android.media.key",
    description: "Send play/pause or volume keyevents via ADB on one unlocked authorized device after trusted confirmation. Cannot unlock the phone or send messages.",
    risk: "reversible_write",
    permissionScope: "android:media:key",
    async execute(input): Promise<AndroidMediaKeyResult> {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1) {
        throw new Error("Malformed Android media input.");
      }
      const action = input.action;
      if (action !== "play_pause" && action !== "volume_up" && action !== "volume_down") {
        throw new Error("Action must be play_pause, volume_up, or volume_down.");
      }
      const keyCode = MEDIA_KEY_CODES[action];
      const executable = await requireSingleAuthorizedDevice(runner);
      await runner(executable, ["shell", "input", "keyevent", String(keyCode)], {
        timeout: 5_000, maxBuffer: 16_384, windowsHide: true,
      });
      return {
        action,
        keyCode,
        sent: true,
        note: "Works only while the phone is unlocked and ADB-authorized. Ultron cannot unlock or auto-message.",
      };
    },
  };
}
