import { getUltronRuntime } from "@/core/runtime";
import { authorizeRuntimeRequest } from "@/core/localHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPE_PATTERN = /^[\w.:-]{1,200}$/;

export async function GET(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  const grants = await getUltronRuntime().permissions.grants();
  return Response.json({ grants }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  const scope = new URL(request.url).searchParams.get("scope") ?? "";
  if (!SCOPE_PATTERN.test(scope)) {
    return Response.json({ error: "Invalid permission scope." }, { status: 400 });
  }
  const revoked = await getUltronRuntime().permissions.revoke(scope);
  return Response.json({ revoked }, { status: revoked ? 200 : 404 });
}
