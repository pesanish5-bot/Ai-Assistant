import { readActivationEnabled, writeActivationEnabled } from "@/core/activationControl";
import { isAllowedLocalHttpRequest, localOnlyResponse } from "@/core/localHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAllowedLocalHttpRequest(request)) return localOnlyResponse();
  return Response.json({ enabled: readActivationEnabled() }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  if (!isAllowedLocalHttpRequest(request)) return localOnlyResponse();
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
    return Response.json({ enabled: readActivationEnabled() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Unable to update background activation." }, { status: 400 });
  }
}
