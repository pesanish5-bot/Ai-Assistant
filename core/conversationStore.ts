import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConversationMemory, type ConversationMessage } from "./conversationMemory.ts";
import { calendarDate, MarkdownVault } from "./vault.ts";

interface StoredSessions {
  version: 1;
  sessions: Record<string, { updatedAt: number; messages: ConversationMessage[] }>;
}

const CONVERSATION_TTL_MS = 24 * 60 * 60_000;

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

function summarizeExpiredSession(messages: ConversationMessage[]): string {
  const lines = messages
    .filter((item) => item.cloudEligible || item.role === "user")
    .slice(-12)
    .map((item) => `- ${item.role}: ${item.text.slice(0, 240).replace(/\s+/g, " ")}`);
  return lines.length
    ? ["Expired conversation summary (auto-archived when the 24h working memory TTL elapsed):", "", ...lines].join("\n")
    : "Expired conversation had no cloud-eligible turns.";
}

/** Local conversation file under Ultron state. It is not part of the Vault. */
export function openConversation(dataDir: string, vaultDir?: string): ConversationMemory {
  const filePath = path.join(dataDir, "state", "conversations.json");
  const ttlMs = CONVERSATION_TTL_MS;
  const now = Date.now();
  let restored: StoredSessions["sessions"] = {};
  let expired = false;
  const expiredSessions: Array<{ id: string; messages: ConversationMessage[] }> = [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoredSessions>;
    if (parsed.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
      restored = Object.fromEntries(Object.entries(parsed.sessions).flatMap(([id, session]) => {
        if (!session || typeof session !== "object" || typeof session.updatedAt !== "number" || !Array.isArray(session.messages)) return [];
        const messages = session.messages.filter(isMessage).slice(-24);
        if (now - session.updatedAt > ttlMs) {
          expired = true;
          expiredSessions.push({ id, messages });
          return [];
        }
        return [[id, { updatedAt: session.updatedAt, messages }]];
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

  const archiveExpired = (id: string, messages: ConversationMessage[]) => {
    if (!vaultDir || messages.length === 0) return;
    try {
      const vault = new MarkdownVault(vaultDir);
      void vault.writeOutput({
        kind: "draft",
        type: "conversation-summary",
        topic: "conversation-summary",
        title: `Conversation summary ${calendarDate(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")} (${id})`,
        summary: "Auto-archived working memory after the 24-hour conversation TTL.",
        content: summarizeExpiredSession(messages),
        tags: ["conversation", "auto-archive"],
        data: { sessionId: id, messageCount: messages.length },
      }).catch(() => {
        // Archival is best-effort; the session is still dropped from working memory.
      });
    } catch {
      // Vault may be unavailable during early boot.
    }
  };

  for (const item of expiredSessions) archiveExpired(item.id, item.messages);

  const memory = new ConversationMemory(Date.now, ttlMs, restored, persist, archiveExpired);
  if (expired) persist(restored);
  return memory;
}
