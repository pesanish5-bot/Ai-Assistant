import type { VaultEntry } from "../vault.ts";
import type { SkillDefinition, SkillExecutionContext, SkillResult } from "./types.ts";

interface VaultResultEntry {
  id: string;
  namespace: string;
  kind: string;
  title: string;
  preview: string;
}

interface VaultSkillData {
  action: "captured" | "saved" | "updated" | "searched" | "delete_candidates" | "deleted" | "listed" | "needs_input";
  entries: VaultResultEntry[];
}

function preview(entry: VaultEntry): VaultResultEntry {
  return {
    id: entry.id,
    namespace: entry.namespace,
    kind: entry.kind,
    title: entry.title,
    preview: entry.content.slice(0, 140),
  };
}

function titleFromContent(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  return clean.length > 64 ? `${clean.slice(0, 61)}...` : clean;
}

function result(
  context: SkillExecutionContext,
  summary: string,
  data: VaultSkillData,
  warnings: string[] = [],
): SkillResult<VaultSkillData> {
  return {
    skill: "vault",
    timestamp: context.now.toISOString(),
    summary,
    sections: data.entries.length
      ? [{ title: "Vault", items: data.entries.map((entry) => `${entry.title} — ${entry.preview || entry.kind} [${entry.id}]`) }]
      : [],
    data,
    warnings,
  };
}

async function executeVault(context: SkillExecutionContext): Promise<SkillResult<VaultSkillData>> {
  const message = context.message.trim();
  const remember = message.match(/^remember(?: that)?\s+(.+)/i);
  const saveNote = message.match(/^save (?:a )?note(?: that)?\s+(.+)/i);
  const rawCapture = message.match(/^capture raw(?: that)?\s+(.+)/i);

  if (rawCapture) {
    const content = rawCapture[1].trim();
    const entry = await context.vault.captureRaw({
      title: titleFromContent(content),
      content,
      summary: `Unprocessed capture: ${titleFromContent(content)}`,
      tags: ["raw", "manual-capture"],
    });
    return result(context, "Captured without rewriting it in your Markdown Vault.", {
      action: "captured",
      entries: [preview(entry)],
    });
  }

  if (remember || saveNote) {
    const content = (remember?.[1] ?? saveNote?.[1] ?? "").trim();
    if (!content || content.toLowerCase() === "this") {
      return result(
        context,
        "Tell me the information you want saved.",
        { action: "needs_input", entries: [] },
        ["No content was provided."],
      );
    }
    const entry = await context.vault.save({
      namespace: remember ? "memory" : "knowledge",
      kind: "note",
      title: titleFromContent(content),
      content,
      tags: remember ? ["remembered"] : ["note"],
    });
    return result(context, "Saved to your private local Vault.", {
      action: "saved",
      entries: [preview(entry)],
    });
  }

  const updateById = message.match(/^update entry\s+([a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?)\s+(?:to|with)\s+(.+)/i);
  if (updateById) {
    const updated = await context.vault.update(updateById[1], {
      content: updateById[2],
      summary: titleFromContent(updateById[2]),
    });
    return result(
      context,
      updated ? "The selected Vault entry was updated." : "I could not find that Vault entry.",
      { action: "updated", entries: updated ? [preview(updated)] : [] },
      updated ? [] : ["No entry matched the supplied id."],
    );
  }

  const forgetById = message.match(/^forget entry\s+([a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?)$/i);
  if (forgetById) {
    const removed = await context.vault.remove(forgetById[1]);
    return result(
      context,
      removed ? "The selected Vault entry was forgotten." : "I could not find that Vault entry.",
      { action: "deleted", entries: [] },
      removed ? [] : ["No entry matched the supplied id."],
    );
  }

  const forgetQuery = message.match(/^forget\s+(.+)/i);
  if (forgetQuery) {
    const matches = await context.vault.search({ text: forgetQuery[1], limit: 8 });
    return result(
      context,
      matches.length
        ? "I found possible matches. Use “forget entry <id>” to remove exactly one."
        : "I found nothing matching that request.",
      { action: "delete_candidates", entries: matches.map(preview) },
    );
  }

  const search =
    message.match(/^what do you know about\s+(.+)/i) ??
    message.match(/^search (?:the )?vault for\s+(.+)/i) ??
    message.match(/^find (?:my )?notes? (?:about|for)\s+(.+)/i);
  if (search) {
    const query = search[1];
    const matches = await context.vault.search({
      text: query,
      ...(/\bprojects?\b/i.test(query) ? { kind: "project" as const } : {}),
      limit: 10,
    });
    return result(
      context,
      matches.length ? `I found ${matches.length} relevant Vault entr${matches.length === 1 ? "y" : "ies"}.` : "No relevant Vault entries were found.",
      { action: "searched", entries: matches.map(preview) },
    );
  }

  const entries = await context.vault.search({ limit: 10 });
  return result(context, entries.length ? "Here are the latest Vault entries." : "Your Vault is empty.", {
    action: "listed",
    entries: entries.map(preview),
  });
}

export function createVaultSkill(): SkillDefinition<VaultSkillData> {
  return {
    id: "vault",
    name: "Vault",
    description: "Save, retrieve, search, and explicitly forget personal knowledge.",
    priority: 3,
    routes: [
      { phrases: ["capture raw", "remember", "remember that", "save a note", "save note", "update entry", "forget", "forget entry"], weight: 10 },
      { phrases: ["what do you know about", "search vault", "search the vault", "show my notes", "open vault"], weight: 8 },
    ],
    execute: executeVault,
  };
}
