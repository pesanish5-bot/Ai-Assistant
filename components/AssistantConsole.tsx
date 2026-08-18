"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { faceController } from "@/interaction/face/faceController";
import type { FaceState } from "@/lib/faceState";

interface ConsoleMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
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
  'Ultron foundation online. Ask for your plan, inbox, metrics, trends, or Vault. Try "remember that..." to save private local context.';

export default function AssistantConsole() {
  const [messages, setMessages] = useState<ConsoleMessage[]>([
    { id: 0, role: "assistant", text: STARTER },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const nextId = useRef(1);
  const errorTimer = useRef<number | null>(null);

  useEffect(() => {
    faceController.setState("idle");
    return () => {
      if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    };
  }, []);

  function append(role: ConsoleMessage["role"], text: string) {
    setMessages((current) => [...current, { id: nextId.current++, role, text }]);
  }

  async function run(message: string, confirmationId?: string, rememberPermission = false) {
    if (errorTimer.current !== null) {
      window.clearTimeout(errorTimer.current);
      errorTimer.current = null;
    }
    setBusy(true);
    faceController.setState("thinking");
    let completedState: FaceState = "idle";
    try {
      const response = await fetch("/api/ultron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, confirmationId, rememberPermission }),
      });
      const body = (await response.json()) as ApiResponse | { error?: string };

      if (!("status" in body)) {
        append("assistant", body.error ?? "Ultron returned an invalid response.");
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
      append("assistant", body.human);
      if (body.status === "error") completedState = "error";
    } catch {
      append("assistant", "Ultron could not reach its local runtime.");
      completedState = "error";
    } finally {
      setBusy(false);
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
    if (!message || busy) return;
    append("user", message);
    setInput("");
    setPending(null);
    void run(message);
  }

  return (
    <section className="assistant-console" aria-label="Ultron console">
      <header className="console-header">
        <span className="console-brand">
          <strong>ULTRON</strong>
          <small>PERSONAL AI OS</small>
        </span>
        <span className={`console-status${busy ? " busy" : ""}`}>{busy ? "WORKING" : "READY"}</span>
      </header>

      <div className="console-messages" aria-live="polite">
        {messages.map((message) => (
          <article key={message.id} className={`console-message ${message.role}`}>
            <span>{message.role === "user" ? "YOU" : "ULTRON"}</span>
            <p>{message.text}</p>
          </article>
        ))}
      </div>

      {pending && (
        <div className="permission-card">
          <strong>PERMISSION REQUIRED // {pending.risk.toUpperCase()}</strong>
          <p>{pending.description}</p>
          <div>
            <button type="button" onClick={() => void run(pending.message, pending.id)} disabled={busy}>
              ALLOW ONCE
            </button>
            <button
              type="button"
              onClick={() => void run(pending.message, pending.id, true)}
              disabled={busy}
            >
              ALWAYS ALLOW THIS
            </button>
            <button type="button" onClick={() => setPending(null)} disabled={busy}>
              DENY
            </button>
          </div>
        </div>
      )}

      <form className="console-input" onSubmit={submit}>
        <label htmlFor="ultron-command">COMMAND</label>
        <input
          id="ultron-command"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Good morning..."
          maxLength={4000}
          disabled={busy}
          autoComplete="off"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          SEND
        </button>
      </form>
    </section>
  );
}
