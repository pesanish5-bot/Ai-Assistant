import { getUltronRuntime } from "@/core/runtime";
import { isAuthorizedInteractionToken, getInteractionStateProjector } from "@/core/interactionState";
import { authorizeRuntimeRequest } from "@/core/localHttp";
import { getDeviceTokenStore } from "@/core/deviceAuth";
import { loadConfig } from "@/core/config";
import { PermissionConfirmationError, TrustedWriteConfirmationRequiredError } from "@/core/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHALLENGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolveWriteAuth(request: Request): Promise<"launcher" | "device" | null> {
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (isAuthorizedInteractionToken(provided, process.env.ULTRON_LOCAL_EVENT_TOKEN)) {
    return "launcher";
  }
  const deviceToken = provided ?? request.headers.get("x-ultron-device-token");
  if (await getDeviceTokenStore(loadConfig().dataDir).verify(deviceToken)) {
    return "device";
  }
  return null;
}

export async function POST(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;

  const writeAuth = await resolveWriteAuth(request);
  if (!writeAuth) {
    return Response.json(
      { error: "Write confirmation requires the launcher event token or a registered device token." },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Request body must be an object." }, { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const challengeId = record.challengeId;
  const approve = record.approve;
  const method = record.method === "voice" ? "voice" : record.method === "authenticated_ui" || record.method === undefined
    ? "authenticated_ui"
    : null;
  const speakerVerified = record.speakerVerified === true;

  if (typeof challengeId !== "string" || !CHALLENGE_ID_PATTERN.test(challengeId)) {
    return Response.json({ error: "challengeId must be a UUID." }, { status: 400 });
  }
  if (typeof approve !== "boolean") {
    return Response.json({ error: "approve must be a boolean." }, { status: 400 });
  }
  if (!method) {
    return Response.json({ error: "method must be authenticated_ui or voice." }, { status: 400 });
  }
  if (method === "voice" && writeAuth === "device") {
    return Response.json({ error: "Voice write confirmation is only available on the PC." }, { status: 403 });
  }
  if (method === "voice" && Object.prototype.hasOwnProperty.call(record, "speakerVerified") && typeof record.speakerVerified !== "boolean") {
    return Response.json({ error: "speakerVerified must be a boolean when provided." }, { status: 400 });
  }

  const pending = getUltronRuntime().permissions.peekChallenge(challengeId);
  if (writeAuth === "device" && pending?.risk === "consequential_write") {
    return Response.json(
      { error: "Consequential writes require the PC trusted confirmation channel." },
      { status: 403 },
    );
  }

  try {
    const result = await getUltronRuntime().permissions.decideWrite({
      challengeId,
      approve,
      method,
      ...(method === "voice" ? { speakerVerified } : {}),
    });
    try {
      getInteractionStateProjector().apply({
        name: "permission.write_resolved",
        timestamp: Date.now(),
        payload: {
          challenge_id: result.challenge.id,
          tool_name: result.challenge.toolName,
          scope: result.challenge.scope,
          risk: result.challenge.risk,
          approved: result.stamped,
        },
      });
    } catch {
      // Best-effort HUD update.
    }
    return Response.json(
      {
        stamped: result.stamped,
        confirmation: {
          id: result.challenge.id,
          risk: result.challenge.risk,
          scope: result.challenge.scope,
          toolName: result.challenge.toolName,
          description: result.challenge.description,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TrustedWriteConfirmationRequiredError) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof PermissionConfirmationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: "Unable to record write confirmation." }, { status: 500 });
  }
}
