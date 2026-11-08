import { getUltronRuntime } from "@/core/runtime";
import { getInteractionStateProjector } from "@/core/interactionState";
import { authorizeRuntimeRequest } from "@/core/localHttp";
import { validateSessionId } from "@/core/conversationMemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Single SSE stream replacing HUD 1-second polling for conversation + interaction.
 * Device-token remote clients must send Authorization / x-ultron-device-token.
 */
export async function GET(request: Request) {
  const auth = await authorizeRuntimeRequest(request);
  if (!auth.ok) return auth.response;

  let sessionId = "local";
  try {
    const raw = new URL(request.url).searchParams.get("sessionId") ?? "local";
    validateSessionId(raw);
    sessionId = raw;
  } catch {
    return Response.json({ error: "Invalid conversation session id." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      let interactionAfter = 0;
      let interactionGeneration: string | null = null;
      let lastConversationFingerprint = "";

      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const tick = () => {
        if (closed) return;
        try {
          const projector = getInteractionStateProjector();
          const snapshot = projector.snapshot(interactionAfter, interactionGeneration ?? undefined);
          if (interactionGeneration !== snapshot.generation) {
            interactionGeneration = snapshot.generation;
            interactionAfter = 0;
          }
          if (snapshot.sequence > interactionAfter) {
            send("interaction", snapshot);
            interactionAfter = snapshot.sequence;
          }

          const core = getUltronRuntime();
          const conversation = { ...core.conversation.snapshot(sessionId), brain: core.brainStatus() };
          const fingerprint = JSON.stringify({
            busy: conversation.busy,
            pending: conversation.pending?.id ?? null,
            count: conversation.messages.length,
            last: conversation.messages.at(-1)?.id ?? null,
          });
          if (fingerprint !== lastConversationFingerprint) {
            lastConversationFingerprint = fingerprint;
            send("conversation", conversation);
          }
        } catch {
          // Keep the stream alive across transient projector/runtime hiccups.
        }
      };

      send("ready", { remote: auth.remote, sessionId });
      tick();
      const interval = setInterval(tick, 400);
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15_000);

      const abort = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };
      request.signal.addEventListener("abort", abort);
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
