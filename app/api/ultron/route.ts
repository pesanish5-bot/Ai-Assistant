import { getUltronRuntime } from "@/core/runtime";
import { isAllowedLocalHttpRequest, localOnlyResponse } from "@/core/localHttp";

export const runtime = "nodejs";

interface RequestBody {
  message?: unknown;
  confirmationId?: unknown;
  rememberPermission?: unknown;
}

export async function GET(request: Request) {
  if (!isAllowedLocalHttpRequest(request)) return localOnlyResponse();
  const ultron = getUltronRuntime();
  return Response.json({
    skills: ultron.skills.list().map(({ id, name, description }) => ({ id, name, description })),
    tools: ultron.tools.list(),
  });
}

export async function POST(request: Request) {
  if (!isAllowedLocalHttpRequest(request)) return localOnlyResponse();
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
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

  const response = await getUltronRuntime().execute({
    message: body.message,
    ...(typeof body.confirmationId === "string" ? { confirmationId: body.confirmationId } : {}),
    rememberPermission: body.rememberPermission === true,
  });
  return Response.json(response, { status: response.status === "error" ? 500 : 200 });
}
