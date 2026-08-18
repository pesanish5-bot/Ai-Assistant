import {
  getInteractionStateProjector,
  isAuthorizedInteractionToken,
} from "@/core/interactionState";
import { isAllowedLocalHttpRequest, localOnlyResponse } from "@/core/localHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAllowedLocalHttpRequest(request)) return localOnlyResponse();
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
  if (!isAllowedLocalHttpRequest(request)) return localOnlyResponse();
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
