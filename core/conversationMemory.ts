import { randomUUID } from "node:crypto";
import type { LanguageModelRequest } from "./llm.ts";
import type { PermissionChallenge } from "./permissions.ts";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  source: "text" | "voice";
  timestamp: string;
  cloudEligible: boolean;
}

interface Session {
  messages: ConversationMessage[];
  updatedAt: number;
  busy: boolean;
  pending?: { message: string; challenge: PermissionChallenge };
}

export function validateSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid conversation session id.");
}

/** Bounded working memory, never written to the Vault or disk. */
export class ConversationMemory {
  private readonly sessions = new Map<string, Session>();

  private readonly clock: () => number;
  private readonly ttlMs: number;
  constructor(clock = Date.now, ttlMs = 30 * 60_000) { this.clock = clock; this.ttlMs = ttlMs; }

  private session(id: string): Session {
    validateSessionId(id);
    for (const [key, session] of this.sessions) {
      if (!session.busy && this.clock() - session.updatedAt > this.ttlMs) this.sessions.delete(key);
    }
    let session = this.sessions.get(id);
    if (!session) {
      if (this.sessions.size >= 32) {
        const oldest = [...this.sessions].filter(([, item]) => !item.busy).sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
        if (!oldest) throw new Error("Conversation capacity reached.");
        this.sessions.delete(oldest[0]);
      }
      session = { messages: [], updatedAt: this.clock(), busy: false };
      this.sessions.set(id, session);
    }
    return session;
  }

  begin(id: string): boolean {
    const session = this.session(id);
    if (session.busy) return false;
    session.busy = true;
    session.updatedAt = this.clock();
    return true;
  }

  finish(id: string): void { const session = this.session(id); session.busy = false; session.updatedAt = this.clock(); }

  add(id: string, role: ConversationMessage["role"], text: string, source: ConversationMessage["source"], cloudEligible = false): void {
    const session = this.session(id);
    session.messages.push({ id: randomUUID(), role, text: text.slice(0, 12_000), source, cloudEligible, timestamp: new Date(this.clock()).toISOString() });
    while (session.messages.length > 24 || session.messages.reduce((total, item) => total + item.text.length, 0) > 32_000) session.messages.shift();
    session.updatedAt = this.clock();
  }

  history(id: string): LanguageModelRequest["messages"] {
    return this.session(id).messages.filter((item) => item.cloudEligible).map(({ role, text }) => ({ role, content: text }));
  }

  approveForCloud(id: string): void {
    const messages = this.session(id).messages;
    const last = messages[messages.length - 1];
    if (last?.role === "user") last.cloudEligible = true;
  }

  pending(id: string, value?: Session["pending"]): void { this.session(id).pending = value; }

  snapshot(id: string) {
    const session = this.session(id);
    return {
      messages: session.messages.map(({ cloudEligible: _private, ...message }) => message),
      busy: session.busy,
      pending: session.pending ? { message: session.pending.message, ...session.pending.challenge } : null,
    };
  }

  clear(id: string): boolean {
    if (this.session(id).busy) return false;
    this.sessions.delete(id);
    return true;
  }
}
