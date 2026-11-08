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
  stream?: unknown;
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
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return Response.json({ error: "stream must be a boolean." }, { status: 400 });
  }

  const limit = localRequestLimiter().tryAcquire();
  if (!limit.ok) {
    return Response.json(
      { error: "Too many local requests. Wait a moment before trying again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }

  const runtimeRequest = {
    message: body.message,
    ...(typeof body.confirmationId === "string" ? { confirmationId: body.confirmationId } : {}),
    rememberPermission: body.rememberPermission === true,
    ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
    source: body.source === "voice" ? "voice" as const : "text" as const,
  };

  if (body.stream === true) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const frame of getUltronRuntime().executeStream(runtimeRequest)) {
            controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
          }
        } catch {
          controller.enqueue(encoder.encode(`${JSON.stringify({
            type: "error",
            response: { status: "error", requestId: "stream", human: "Ultron could not stream that reply." },
          })}\n`));
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const response = await getUltronRuntime().execute(runtimeRequest);
  return Response.json(response, { status: response.status === "error" ? 500 : 200 });
}
