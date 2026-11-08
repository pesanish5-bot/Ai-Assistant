import { getUltronRuntime } from "@/core/runtime";
import { validateSessionId } from "@/core/conversationMemory";
import { authorizeRuntimeRequest } from "@/core/localHttp";

export const runtime = "nodejs";

function sessionId(request: Request): string {
  const id = new URL(request.url).searchParams.get("sessionId") ?? "local";
  validateSessionId(id);
  return id;
}

export async function GET(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  let id: string;
  try { id = sessionId(request); } catch { return Response.json({ error: "Invalid conversation session id." }, { status: 400 }); }
  const core = getUltronRuntime();
  return Response.json({ ...core.conversation.snapshot(id), brain: core.brainStatus() }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  let id: string;
  try { id = sessionId(request); } catch { return Response.json({ error: "Invalid conversation session id." }, { status: 400 }); }
  const cleared = getUltronRuntime().clearConversation(id);
  return Response.json({ cleared }, { status: cleared ? 200 : 409 });
}

export async function PATCH(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  let id: string;
  try { id = sessionId(request); } catch { return Response.json({ error: "Invalid conversation session id." }, { status: 400 }); }
  const cancelled = getUltronRuntime().cancelConfirmation(id);
  return Response.json({ cancelled }, { status: cancelled ? 200 : 409 });
}
