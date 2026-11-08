import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConversationMemory, type ConversationMessage } from "./conversationMemory.ts";

interface StoredSessions {
  version: 1;
  sessions: Record<string, { updatedAt: number; messages: ConversationMessage[] }>;
}

function isMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ConversationMessage>;
  return (message.role === "user" || message.role === "assistant")
    && typeof message.id === "string"
    && typeof message.text === "string"
    && (message.source === "text" || message.source === "voice")
    && typeof message.timestamp === "string"
    && typeof message.cloudEligible === "boolean";
}

/** Local conversation file under Ultron state. It is not part of the Vault. */
export function openConversation(dataDir: string): ConversationMemory {
  const filePath = path.join(dataDir, "state", "conversations.json");
  const ttlMs = 30 * 60_000;
  const now = Date.now();
  let restored: StoredSessions["sessions"] = {};
  let expired = false;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoredSessions>;
    if (parsed.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
      restored = Object.fromEntries(Object.entries(parsed.sessions).flatMap(([id, session]) => {
        if (!session || typeof session !== "object" || typeof session.updatedAt !== "number" || !Array.isArray(session.messages)) return [];
        if (now - session.updatedAt > ttlMs) {
          expired = true;
          return [];
        }
        return [[id, { updatedAt: session.updatedAt, messages: session.messages.filter(isMessage).slice(-24) }]];
      }));
    }
  } catch {
    restored = {};
  }
  const persist = (sessions: StoredSessions["sessions"]) => {
    const document: StoredSessions = { version: 1, sessions };
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, "utf8");
    try {
      // Replacing the destination in one rename avoids a gap with no conversation file.
      renameSync(temporary, filePath);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Preserve the original error. */ }
      throw error;
    }
  };
  const memory = new ConversationMemory(Date.now, ttlMs, restored, persist);
  if (expired) persist(restored);
  return memory;
}
