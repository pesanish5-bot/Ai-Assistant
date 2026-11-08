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
  scope: string;
}

interface StoredGrant {
  scope: string;
  grantedAt: string;
}

interface VaultListEntry {
  id: string;
  kind: string;
  title: string;
  summary: string;
  content?: string;
}

type ApiResponse =
  | { status: "ok"; human: string }
  | { status: "unsupported"; human: string }
  | { status: "error"; human: string }
  | {
      status: "confirmation_required";
      confirmation: { id: string; description: string; risk: string; scope: string };
    };

const STARTER =
  'Start with add task, done task, add project Name: goal, block project Name: blocker, project status, add inbox, or remember that. VAULT lists saved pages. ACCESS revokes remembered permissions.';

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
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [grants, setGrants] = useState<StoredGrant[]>([]);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultEntries, setVaultEntries] = useState<VaultListEntry[]>([]);
  const [vaultDetail, setVaultDetail] = useState("");
  const nextId = useRef(1);
  const errorTimer = useRef<number | null>(null);
  const messagesEnd = useRef<HTMLDivElement | null>(null);
  const working = busy || remoteBusy;

  const loadGrants = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/permissions", { cache: "no-store", signal });
    if (!response.ok) throw new Error("Permissions unavailable");
    const body = await response.json() as { grants?: StoredGrant[] };
    setGrants(Array.isArray(body.grants) ? body.grants : []);
  }, []);

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
          scope: body.confirmation.scope,
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
      if (grantsOpen) { try { await loadGrants(AbortSignal.timeout(2_000)); } catch { } }
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

  async function loadVault() {
    const response = await fetch("/api/vault", { cache: "no-store", signal: AbortSignal.timeout(4_000) }).catch(() => null);
    if (!response?.ok) { setNotice("Could not load the Vault."); return; }
    const body = await response.json() as { entries?: VaultListEntry[] };
    setVaultEntries(Array.isArray(body.entries) ? body.entries : []);
    setVaultDetail("");
    setNotice("");
  }

  async function openVaultEntry(id: string) {
    const response = await fetch(`/api/vault?id=${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(4_000) }).catch(() => null);
    if (!response?.ok) { setNotice("Could not open that Vault page."); return; }
    const body = await response.json() as { entry?: VaultListEntry };
    setVaultDetail(body.entry?.content ?? body.entry?.summary ?? "");
  }

  async function toggleVault() {
    const next = !vaultOpen;
    setVaultOpen(next);
    if (next) await loadVault();
  }

  async function toggleGrants() {
    const next = !grantsOpen;
    setGrantsOpen(next);
    if (!next) return;
    try { await loadGrants(AbortSignal.timeout(2_000)); }
    catch { setNotice("Could not load remembered permissions."); }
  }

  async function revokeGrant(scope: string) {
    const response = await fetch(`/api/permissions?scope=${encodeURIComponent(scope)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    if (!response?.ok) { setNotice("Could not revoke that permission."); return; }
    setNotice("");
    try { await loadGrants(AbortSignal.timeout(2_000)); }
    catch { setNotice("The permission was revoked, but the list could not be refreshed."); }
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
        <span className="console-actions">
          <button type="button" className="console-clear" onClick={() => void toggleVault()} title="List saved Vault pages">VAULT</button>
          <button type="button" className="console-clear" onClick={() => void toggleGrants()} title="Show and revoke remembered permissions">ACCESS</button>
          <button type="button" className="console-clear" onClick={() => void clearConversation()} disabled={working} title="Clear temporary conversation; saved Vault notes stay available">CLEAR CHAT</button>
        </span>
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

      {vaultOpen && (
        <div className="permission-card">
          <strong>VAULT</strong>
          {vaultEntries.length === 0 ? <p>No saved pages yet.</p> : (
            <ul className="grant-list">
              {vaultEntries.map((entry) => (
                <li key={entry.id}>
                  <span>{entry.kind}: {entry.title}</span>
                  <button type="button" onClick={() => void openVaultEntry(entry.id)}>OPEN</button>
                </li>
              ))}
            </ul>
          )}
          {vaultDetail && <p>{vaultDetail}</p>}
        </div>
      )}

      {grantsOpen && (
        <div className="permission-card">
          <strong>REMEMBERED PERMISSIONS</strong>
          {grants.length === 0 ? <p>No remembered permissions. One-time approvals are not stored.</p> : (
            <ul className="grant-list">
              {grants.map((grant) => (
                <li key={grant.scope}>
                  <span>{grant.scope}</span>
                  <button type="button" onClick={() => void revokeGrant(grant.scope)}>REVOKE</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pending && (
        <div className="permission-card">
          <strong>PERMISSION REQUIRED // {pending.risk.toUpperCase()}</strong>
          <p>{pending.description}</p>
          <p>Scope: {pending.scope}. ALWAYS ALLOW stores this scope until you revoke it under ACCESS.</p>
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
