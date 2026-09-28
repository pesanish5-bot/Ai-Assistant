"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { faceController } from "@/interaction/face/faceController";
import type { FaceState } from "@/lib/faceState";

interface ConsoleMessage {
  id: string | number;
  role: "user" | "assistant";
  text: string;
  source?: "text" | "voice";
}

interface PendingConfirmation {
  id: string;
  message: string;
  description: string;
  risk: string;
}

type ApiResponse =
  | { status: "ok"; human: string }
  | { status: "unsupported"; human: string }
  | { status: "error"; human: string }
  | {
      status: "confirmation_required";
      confirmation: { id: string; description: string; risk: string };
    };

const STARTER =
  'Talk or type to Ultron. Ask for help, draft a message, translate text, or use "dictate: ..." to write your words locally. Say "remember that..." when you want information saved.';

interface ConversationSnapshot {
  messages: ConsoleMessage[];
  busy: boolean;
  brain: { configured: boolean };
  pending: (PendingConfirmation & { expiresAt: string }) | null;
}

export default function AssistantConsole() {
  const [messages, setMessages] = useState<ConsoleMessage[]>([
    { id: 0, role: "assistant", text: STARTER },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState<string | number | null>(null);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const nextId = useRef(1);
  const errorTimer = useRef<number | null>(null);
  const messagesEnd = useRef<HTMLDivElement | null>(null);
  const working = busy || remoteBusy;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/conversation", { cache: "no-store", signal });
    if (!response.ok) throw new Error("Conversation unavailable");
    const snapshot = await response.json() as ConversationSnapshot;
    setMessages([{ id: 0, role: "assistant", text: STARTER }, ...snapshot.messages]);
    setRemoteBusy(snapshot.busy);
    setConfigured(snapshot.brain.configured);
    setPending(snapshot.pending && Date.parse(snapshot.pending.expiresAt) > Date.now() ? snapshot.pending : null);
  }, []);

  useEffect(() => {
    faceController.setState("idle");
    let disposed = false;
    let active: AbortController | null = null;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const controller = new AbortController();
      active = controller;
      const timeout = window.setTimeout(() => controller.abort(), 2_000);
      try {
        if (!disposed) await refresh(controller.signal);
      } catch { /* The command path reports connection errors when needed. */ }
      finally { window.clearTimeout(timeout); polling = false; }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 1_000);
    return () => {
      disposed = true;
      active?.abort();
      window.clearInterval(interval);
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    };
  }, [refresh]);

  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => { messagesEnd.current?.scrollIntoView({ block: "nearest" }); }, [lastId]);

  function append(role: ConsoleMessage["role"], text: string) {
    setMessages((current) => [...current, { id: nextId.current++, role, text }]);
  }

  async function run(message: string, confirmationId?: string, rememberPermission = false) {
    if (errorTimer.current !== null) {
      window.clearTimeout(errorTimer.current);
      errorTimer.current = null;
    }
    setBusy(true);
    setNotice("");
    faceController.setState("thinking");
    let completedState: FaceState = "idle";
    try {
      const response = await fetch("/api/ultron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, confirmationId, rememberPermission, sessionId: "local", source: "text" }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await response.json()) as ApiResponse | { error?: string };

      if (!("status" in body)) {
        setNotice(body.error ?? "Ultron returned an invalid response.");
        completedState = "error";
        return;
      }
      if (body.status === "confirmation_required") {
        setPending({
          id: body.confirmation.id,
          message,
          description: body.confirmation.description,
          risk: body.confirmation.risk,
        });
        return;
      }

      setPending(null);
      if (body.status === "error") completedState = "error";
    } catch {
      setNotice("Ultron could not reach its local runtime.");
      completedState = "error";
    } finally {
      setBusy(false);
      try { await refresh(AbortSignal.timeout(2_000)); } catch { }
      faceController.setState(completedState);
      if (completedState === "error") {
        errorTimer.current = window.setTimeout(() => {
          if (faceController.getState() === "error") faceController.setState("idle");
          errorTimer.current = null;
        }, 1_800);
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || working) return;
    append("user", message);
    setInput("");
    setPending(null);
    void run(message);
  }

  async function clearConversation(cancelOnly = false) {
    const response = await fetch("/api/conversation", { method: cancelOnly ? "PATCH" : "DELETE", signal: AbortSignal.timeout(2_000) }).catch(() => null);
    if (!response?.ok) { setNotice("Could not update the conversation. Finish the current request and try again."); return; }
    setNotice("");
    setCopied(null);
    try { await refresh(AbortSignal.timeout(2_000)); } catch { setNotice("The local runtime is unavailable."); }
  }

  async function copyMessage(message: ConsoleMessage) {
    try { await navigator.clipboard.writeText(message.text); setCopied(message.id); }
    catch { setNotice("Select the text and copy it manually; clipboard access is unavailable."); }
  }

  return (
    <section className="assistant-console" aria-label="Ultron console">
      <header className="console-header">
        <span className="console-brand">
          <strong>ULTRON</strong>
          <small>PERSONAL AI OS</small>
        </span>
        <span className={`console-status${working ? " busy" : ""}`}>{working ? "WORKING" : configured ? "READY" : "LOCAL"}</span>
        <button type="button" className="console-clear" onClick={() => void clearConversation()} disabled={working} title="Clear temporary conversation; saved Vault notes stay available">CLEAR CHAT</button>
      </header>

      <div className="console-messages" aria-live="polite">
        {messages.map((message) => (
          <article key={message.id} className={`console-message ${message.role}`}>
            <span>{message.role === "user" ? message.source === "voice" ? "YOU // VOICE" : "YOU" : "ULTRON"}</span>
            <p>{message.text}</p>
            {message.role === "assistant" && message.id !== 0 && <button type="button" className="console-copy" onClick={() => void copyMessage(message)}>{copied === message.id ? "COPIED" : "COPY"}</button>}
          </article>
        ))}
        <div ref={messagesEnd} />
      </div>

      {notice && <p className="console-notice" role="status">{notice}</p>}

      {pending && (
        <div className="permission-card">
          <strong>PERMISSION REQUIRED // {pending.risk.toUpperCase()}</strong>
          <p>{pending.description}</p>
          <div>
            <button type="button" onClick={() => void run(pending.message, pending.id)} disabled={working}>
              ALLOW ONCE
            </button>
            <button
              type="button"
              onClick={() => void run(pending.message, pending.id, true)}
              disabled={working}
            >
              ALWAYS ALLOW THIS
            </button>
            <button type="button" onClick={() => void clearConversation(true)} disabled={working}>
              DENY
            </button>
          </div>
        </div>
      )}

      <form className="console-input" onSubmit={submit}>
        <label htmlFor="ultron-command">COMMAND</label>
        <textarea
          id="ultron-command"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Talk, draft, translate, or dictate..."
          maxLength={4000}
          disabled={working}
          autoComplete="off"
          rows={2}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" disabled={working || !input.trim()}>
          SEND
        </button>
      </form>
    </section>
  );
}
