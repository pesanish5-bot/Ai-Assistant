import { readActivationEnabled, writeActivationEnabled } from "@/core/activationControl";
import { getInteractionStateProjector, isAuthorizedInteractionToken } from "@/core/interactionState";
import { isAllowedLocalHttpRequest, localOnlyResponse } from "@/core/localHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isTrustedActivationMutation(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (isAuthorizedInteractionToken(provided, process.env.ULTRON_LOCAL_EVENT_TOKEN)) {
    return true;
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
  if (!isAllowedLocalHttpRequest(request)) return localOnlyResponse();
  return Response.json({ enabled: readActivationEnabled() }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  if (!isAllowedLocalHttpRequest(request)) return localOnlyResponse();
  if (!isTrustedActivationMutation(request)) {
    return Response.json({ error: "Activation changes require the local event token or the Ultron HUD." }, { status: 401 });
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
