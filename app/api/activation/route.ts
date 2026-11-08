import { readActivationEnabled, writeActivationEnabled } from "@/core/activationControl";
import { getInteractionStateProjector, isAuthorizedInteractionToken } from "@/core/interactionState";
import { authorizeRuntimeRequest } from "@/core/localHttp";
import { getDeviceTokenStore } from "@/core/deviceAuth";
import { loadConfig } from "@/core/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isTrustedActivationMutation(request: Request, remote: boolean): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (isAuthorizedInteractionToken(provided, process.env.ULTRON_LOCAL_EVENT_TOKEN)) {
    return true;
  }
  if (remote) {
    const deviceToken = provided ?? request.headers.get("x-ultron-device-token");
    return getDeviceTokenStore(loadConfig().dataDir).verify(deviceToken);
  }
  // Browser HUD toggles are same-origin only; bare loopback curl without a token is rejected.
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (!origin || site !== "same-origin") return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function publishActivationChanged(enabled: boolean): void {
  try {
    getInteractionStateProjector().apply({
      name: "activation.changed",
      timestamp: Date.now(),
      payload: { enabled },
    });
  } catch {
    // HUD notification is best-effort; the persisted switch is authoritative.
  }
}

export async function GET(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  return Response.json({ enabled: readActivationEnabled() }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  if (!(await isTrustedActivationMutation(request, auth.remote))) {
    return Response.json({ error: "Activation changes require the local event token, a device token, or the Ultron HUD." }, { status: 401 });
  }
  try {
    const body: unknown = await request.json();
    if (
      typeof body !== "object" || body === null ||
      Object.keys(body).length !== 1 || !("enabled" in body) ||
      typeof body.enabled !== "boolean"
    ) {
      return Response.json({ error: "Expected an on/off setting." }, { status: 400 });
    }
    writeActivationEnabled(body.enabled);
    const enabled = readActivationEnabled();
    publishActivationChanged(enabled);
    return Response.json({ enabled }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Unable to update background activation." }, { status: 400 });
  }
}
