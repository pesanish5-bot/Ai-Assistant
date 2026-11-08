import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AllowlistedApp {
  id: string;
  label: string;
  path: string;
  processName: string;
}

export interface AllowlistedAndroidPackage {
  id: string;
  label: string;
  package: string;
}

export type MediaProvider = "youtube" | "spotify";

export interface ComputerAllowlist {
  apps: AllowlistedApp[];
  mediaProviders: MediaProvider[];
  androidPackages: AllowlistedAndroidPackage[];
}

const EMPTY: ComputerAllowlist = { apps: [], mediaProviders: ["youtube", "spotify"], androidPackages: [] };

const APP_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const PROCESS_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const PACKAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

function isAbsoluteWindowsExe(filePath: string): boolean {
  return /^[A-Za-z]:\\/.test(filePath) && /\.(exe|bat|cmd)$/i.test(filePath) && !filePath.includes("..");
}

/** Parse and validate the user-edited allowlist document. Fail closed on malformed entries. */
export function parseComputerAllowlist(value: unknown): ComputerAllowlist {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY };
  const record = value as Record<string, unknown>;
  const apps: AllowlistedApp[] = [];
  if (Array.isArray(record.apps)) {
    for (const item of record.apps.slice(0, 40)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const app = item as Record<string, unknown>;
      const id = typeof app.id === "string" ? app.id.trim() : "";
      const label = typeof app.label === "string" ? app.label.trim().slice(0, 80) : "";
      const exePath = typeof app.path === "string" ? app.path.trim() : "";
      const processName = typeof app.processName === "string" ? app.processName.trim() : "";
      if (!APP_ID.test(id) || !label || !isAbsoluteWindowsExe(exePath) || !PROCESS_NAME.test(processName)) continue;
      apps.push({ id, label, path: exePath, processName });
    }
  }

  const mediaProviders: MediaProvider[] = [];
  if (Array.isArray(record.mediaProviders)) {
    for (const item of record.mediaProviders) {
      if (item === "youtube" || item === "spotify") mediaProviders.push(item);
    }
  }
  const uniqueProviders = [...new Set(mediaProviders.length ? mediaProviders : EMPTY.mediaProviders)];

  const androidPackages: AllowlistedAndroidPackage[] = [];
  if (Array.isArray(record.androidPackages)) {
    for (const item of record.androidPackages.slice(0, 40)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const pkg = item as Record<string, unknown>;
      const id = typeof pkg.id === "string" ? pkg.id.trim() : "";
      const label = typeof pkg.label === "string" ? pkg.label.trim().slice(0, 80) : "";
      const packageName = typeof pkg.package === "string" ? pkg.package.trim() : "";
      if (!APP_ID.test(id) || !label || !PACKAGE_NAME.test(packageName)) continue;
      androidPackages.push({ id, label, package: packageName });
    }
  }

  return { apps, mediaProviders: uniqueProviders, androidPackages };
}

export async function loadComputerAllowlist(dataDir: string): Promise<ComputerAllowlist> {
  const filePath = path.join(dataDir, "config", "computer-allowlist.json");
  try {
    const raw = await readFile(filePath, "utf8");
    return parseComputerAllowlist(JSON.parse(raw) as unknown);
  } catch {
    return { ...EMPTY, mediaProviders: [...EMPTY.mediaProviders] };
  }
}

export function resolveAllowlistedApp(allowlist: ComputerAllowlist, appId: string): AllowlistedApp {
  const app = allowlist.apps.find((item) => item.id === appId);
  if (!app) throw new Error(`App "${appId}" is not on the computer allowlist. Edit .ultron/config/computer-allowlist.json.`);
  return app;
}

export function resolveAndroidPackage(
  allowlist: ComputerAllowlist,
  packageId: string,
): AllowlistedAndroidPackage {
  const entry = allowlist.androidPackages.find((item) => item.id === packageId);
  if (!entry) {
    throw new Error(`Android package "${packageId}" is not on the allowlist. Edit .ultron/config/computer-allowlist.json.`);
  }
  return entry;
}
