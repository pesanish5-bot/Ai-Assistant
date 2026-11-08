import { getUltronRuntime } from "@/core/runtime";
import { isAllowedLocalHttpRequest, localOnlyResponse } from "@/core/localHttp";
import { validateSessionId } from "@/core/conversationMemory";
import { localRequestLimiter } from "@/core/requestLimit";

export const runtime = "nodejs";

interface RequestBody {
  message?: unknown;
  confirmationId?: unknown;
  rememberPermission?: unknown;
  sessionId?: unknown;
  source?: unknown;
}

export async function GET(request: Request) {
  if (!isAllowedLocalHttpRequest(request)) return localOnlyResponse();
  const ultron = getUltronRuntime();
  return Response.json({
    skills: ultron.skills.list().map(({ id, name, description }) => ({ id, name, description })),
    tools: ultron.tools.list(),
    brain: ultron.brainStatus(),
  });
}

export async function POST(request: Request) {
  if (!isAllowedLocalHttpRequest(request)) return localOnlyResponse();
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return Response.json({ error: "message is required." }, { status: 400 });
  }
  if (body.message.length > 4_000) {
    return Response.json({ error: "message must be 4,000 characters or fewer." }, { status: 400 });
  }
  if (body.confirmationId !== undefined && typeof body.confirmationId !== "string") {
    return Response.json({ error: "confirmationId must be a string." }, { status: 400 });
  }
  if (body.sessionId !== undefined) {
    try {
      if (typeof body.sessionId !== "string") throw new Error("Invalid session");
      validateSessionId(body.sessionId);
    } catch { return Response.json({ error: "Invalid conversation session id." }, { status: 400 }); }
  }
  if (body.source !== undefined && body.source !== "voice" && body.source !== "text") {
    return Response.json({ error: "source must be text or voice." }, { status: 400 });
  }

  const limit = localRequestLimiter().tryAcquire();
  if (!limit.ok) {
    return Response.json(
      { error: "Too many local requests. Wait a moment before trying again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  const response = await getUltronRuntime().execute({
    message: body.message,
    ...(typeof body.confirmationId === "string" ? { confirmationId: body.confirmationId } : {}),
    rememberPermission: body.rememberPermission === true,
    ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
    source: body.source === "voice" ? "voice" : "text",
  });
  return Response.json(response, { status: response.status === "error" ? 500 : 200 });
}
