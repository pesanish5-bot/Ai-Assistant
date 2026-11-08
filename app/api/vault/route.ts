import { getUltronRuntime } from "@/core/runtime";
import { authorizeRuntimeRequest } from "@/core/localHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicEntry(entry: { id: string; kind: string; title: string; summary: string; content: string; updatedAt: string; tags: string[] }, includeContent: boolean) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    updatedAt: entry.updatedAt,
    tags: entry.tags,
    ...(includeContent ? { content: entry.content.slice(0, 4_000) } : {}),
  };
}

export async function GET(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const vault = getUltronRuntime().vault;
  const id = url.searchParams.get("id");
  if (id) {
    if (!/^[a-z0-9][a-z0-9_.:-]{0,120}$/i.test(id)) return Response.json({ error: "Invalid Vault id." }, { status: 400 });
    const entry = await vault.get(id);
    if (!entry) return Response.json({ error: "Vault entry was not found." }, { status: 404 });
    return Response.json({ entry: publicEntry(entry, true) }, { headers: { "Cache-Control": "no-store" } });
  }
  const text = url.searchParams.get("text")?.trim();
  const entries = await vault.search({ ...(text ? { text } : {}), limit: 20 });
  return Response.json(
    { entries: entries.map((entry) => publicEntry(entry, false)) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
