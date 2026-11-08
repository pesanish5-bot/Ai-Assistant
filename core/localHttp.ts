import { timingSafeEqual } from "node:crypto";
import { getDeviceTokenStore } from "./deviceAuth.ts";
import { loadConfig } from "./config.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parseHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/** Tailscale userspace/CGNAT range 100.64.0.0/10. */
export function isTailscaleCgNatAddress(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    const site = request.headers.get("sec-fetch-site");
    return site !== "cross-site" && site !== "same-site";
  }
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

function matchesLauncherToken(provided: string | null): boolean {
  const expected = process.env.ULTRON_LOCAL_EVENT_TOKEN;
  if (!provided || !expected || expected.length < 32) return false;
  try {
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/**
 * Browser/runtime HTTP is a local transport by default. Tailscale (100.64/10)
 * requests are allowed only with a hashed device token — never open LAN/0.0.0.0.
 */
export function isAllowedLocalHttpRequest(request: Request): boolean {
  const requestHost = parseHostname(request.url);
  if (!requestHost) return false;

  if (LOOPBACK_HOSTS.has(requestHost)) {
    return sameOrigin(request);
  }

  if (!isTailscaleCgNatAddress(requestHost)) return false;
  // Tailnet hosts still require same-origin browser fetches or an explicit device token.
  return sameOrigin(request);
}

export async function authorizeRuntimeRequest(request: Request): Promise<
  | { ok: true; remote: boolean }
  | { ok: false; response: Response }
> {
  const requestHost = parseHostname(request.url);
  if (!requestHost) return { ok: false, response: localOnlyResponse() };

  if (LOOPBACK_HOSTS.has(requestHost)) {
    if (!sameOrigin(request)) return { ok: false, response: localOnlyResponse() };
    return { ok: true, remote: false };
  }

  if (!isTailscaleCgNatAddress(requestHost)) {
    return { ok: false, response: localOnlyResponse() };
  }

  if (!sameOrigin(request) && request.headers.get("origin")) {
    return { ok: false, response: localOnlyResponse() };
  }

  const token = bearerToken(request) ?? request.headers.get("x-ultron-device-token");
  // Launcher token may call the Tailscale-bound host from the PC (minting, readiness).
  if (matchesLauncherToken(token)) {
    return { ok: true, remote: false };
  }
  const dataDir = loadConfig().dataDir;
  const valid = await getDeviceTokenStore(dataDir).verify(token);
  if (!valid) {
    return {
      ok: false,
      response: Response.json(
        { error: "Tailscale remote access requires a registered device bearer token." },
        { status: 401 },
      ),
    };
  }
  return { ok: true, remote: true };
}

export function localOnlyResponse(): Response {
  return Response.json(
    { error: "Ultron's runtime accepts requests only from this computer or an authenticated Tailscale device." },
    { status: 403 },
  );
}
