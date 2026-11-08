import {
  getInteractionStateProjector,
  isAuthorizedInteractionToken,
} from "@/core/interactionState";
import { authorizeRuntimeRequest } from "@/core/localHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const afterValue = url.searchParams.get("after");
  const clientGeneration = url.searchParams.get("generation");
  let after: number | undefined;
  if (afterValue !== null) {
    const parsedAfter = Number(afterValue);
    if (!Number.isSafeInteger(parsedAfter) || parsedAfter < 0) {
      return Response.json({ error: "Invalid interaction sequence." }, { status: 400 });
    }
    after = parsedAfter;
  }
  return Response.json(getInteractionStateProjector().snapshot(after, clientGeneration), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  // Native event bridge stays loopback + launcher token only (never device-token remote).
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  if (auth.remote) {
    return Response.json({ error: "Native interaction events cannot be posted from a remote device." }, { status: 403 });
  }
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!process.env.ULTRON_LOCAL_EVENT_TOKEN) {
    return Response.json({ error: "Local interaction bridge is not enabled." }, { status: 503 });
  }
  if (!isAuthorizedInteractionToken(provided, process.env.ULTRON_LOCAL_EVENT_TOKEN)) {
    return Response.json({ error: "Local interaction event was not authorized." }, { status: 401 });
  }

  try {
    const snapshot = getInteractionStateProjector().apply(await request.json());
    return Response.json(snapshot);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid interaction event." },
      { status: 400 },
    );
  }
}
