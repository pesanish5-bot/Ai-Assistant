import { authorizeRuntimeRequest } from "@/core/localHttp";
import { getDeviceTokenStore } from "@/core/deviceAuth";
import { loadConfig } from "@/core/config";
import { isAuthorizedInteractionToken } from "@/core/interactionState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Loopback + launcher token only: mint a phone device token (shown once). */
export async function POST(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  if (auth.remote) {
    return Response.json({ error: "Device tokens can only be minted on the PC." }, { status: 403 });
  }
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!isAuthorizedInteractionToken(provided, process.env.ULTRON_LOCAL_EVENT_TOKEN)) {
    return Response.json({ error: "Minting a device token requires the launcher event bearer token." }, { status: 401 });
  }

  let label: string | undefined;
  try {
    const body = await request.json() as { label?: unknown };
    if (body && typeof body === "object" && typeof body.label === "string") label = body.label;
  } catch {
    // Empty body is fine.
  }

  const minted = await getDeviceTokenStore(loadConfig().dataDir).register(label);
  return Response.json({
    id: minted.id,
    label: minted.label,
    token: minted.token,
    notice: "Store this token on the phone now. Ultron keeps only a hash and will not show the raw token again.",
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  if (auth.remote) {
    return Response.json({ error: "Device token listing is PC-only." }, { status: 403 });
  }
  const tokens = await getDeviceTokenStore(loadConfig().dataDir).list();
  return Response.json({ tokens }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  if (auth.remote) {
    return Response.json({ error: "Device token revocation is PC-only." }, { status: 403 });
  }
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!isAuthorizedInteractionToken(provided, process.env.ULTRON_LOCAL_EVENT_TOKEN)) {
    return Response.json({ error: "Revoking a device token requires the launcher event bearer token." }, { status: 401 });
  }
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[a-f0-9]{16}$/i.test(id)) {
    return Response.json({ error: "Invalid device token id." }, { status: 400 });
  }
  const revoked = await getDeviceTokenStore(loadConfig().dataDir).revoke(id);
  return Response.json({ revoked }, { status: revoked ? 200 : 404 });
}
