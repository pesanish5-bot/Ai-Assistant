const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parseHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/**
 * Browser/runtime HTTP is a local transport only. Authentication and biometric
 * material use a separate native boundary and must never pass through this API.
 */
export function isAllowedLocalHttpRequest(request: Request): boolean {
  const requestHost = parseHostname(request.url);
  if (!requestHost || !LOOPBACK_HOSTS.has(requestHost)) return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  const originHost = parseHostname(origin);
  return originHost !== null && LOOPBACK_HOSTS.has(originHost);
}

export function localOnlyResponse(): Response {
  return Response.json(
    { error: "Ultron's local runtime accepts requests only from this computer." },
    { status: 403 },
  );
}
