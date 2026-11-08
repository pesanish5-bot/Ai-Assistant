import { calendarDate, type VaultEntry } from "../vault.ts";
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

function shiftDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function splitDue(value: string, context: SkillExecutionContext): { text: string; dueAt?: string } {
  const match = value.match(/^(.*?)(?:\s+due\s+(\d{4}-\d{2}-\d{2}|tomorrow|today))\s*$/i);
  if (!match) return { text: value };
  const today = calendarDate(context.now, context.config.timezone);
  const dueAt = /^tomorrow$/i.test(match[2]) ? shiftDate(today, 1) : /^today$/i.test(match[2]) ? today : match[2];
  return { text: match[1].trim(), dueAt };
}

async function updateMatch(
  context: SkillExecutionContext,
  kind: "task" | "project",
  query: string,
  data: (entry: VaultEntry) => Record<string, unknown>,
  summary: string,
): Promise<SkillResult<VaultSkillData>> {
  const matches = (await context.vault.search({ kind, text: query, limit: 8 })).filter((entry) => entry.data.status !== "done" && entry.data.status !== "complete");
  if (matches.length !== 1) {
    return result(
      context,
      matches.length ? "Say the exact saved title so Ultron updates one record." : "No matching open record was found.",
      { action: matches.length ? "delete_candidates" : "needs_input", entries: matches.map(preview) },
    );
  }
  const updated = await context.vault.update(matches[0].id, { data: data(matches[0]) });
  return result(context, updated ? summary : "That record could not be updated.", { action: "updated", entries: updated ? [preview(updated)] : [] });
}

async function executeVault(context: SkillExecutionContext): Promise<SkillResult<VaultSkillData>> {
  const message = context.message.trim();
  if (/^add (?:task|project|inbox)$/i.test(message)) {
    return result(
      context,
      "Add the details after the command.",
      { action: "needs_input", entries: [] },
      ["No content was provided."],
    );
  }

  const addTask = message.match(/^add task\s+(.+)/i);
  if (addTask) {
    const parsed = splitDue(addTask[1].trim(), context);
    const outcome = parsed.text;
    const entry = await context.vault.save({
      namespace: "knowledge",
      kind: "task",
      title: titleFromContent(outcome),
      content: outcome,
      summary: titleFromContent(outcome),
      tags: ["task"],
      data: { status: "open", priority: 3, outcome, ...(parsed.dueAt ? { dueAt: parsed.dueAt } : {}) },
    });
    return result(context, parsed.dueAt ? `Saved the task, due ${parsed.dueAt}.` : "Saved the task. Plan can use it.", { action: "saved", entries: [preview(entry)] });
  }

  const doneTask = message.match(/^done task\s+(.+)/i);
  if (doneTask) return updateMatch(context, "task", doneTask[1], (entry) => ({ ...entry.data, status: "done" }), "Marked that task done.");

  const blockProject = message.match(/^block project\s+(.+)/i);
  if (blockProject) {
    const split = blockProject[1].match(/^(.+?)\s*(?::)\s+(.+)$/);
    if (!split) return result(context, "Use “block project Name: what is blocking it”.", { action: "needs_input", entries: [] }, ["No blocker was provided."]);
    return updateMatch(context, "project", split[1], (entry) => ({ ...entry.data, blocker: split[2].trim(), status: "active" }), "Saved the project blocker.");
  }

  if (/^project status$/i.test(message)) {
    const projects = await context.vault.search({ kind: "project", limit: 20 });
    return result(
      context,
      projects.length ? `Found ${projects.length} project record${projects.length === 1 ? "" : "s"}.` : "No projects are saved yet.",
      { action: "listed", entries: projects.map(preview) },
    );
  }

  const addProject = message.match(/^add project\s+(.+)/i);
  if (addProject) {
    const raw = addProject[1].trim();
    const split = raw.match(/^(.+?)\s*(?::|\bgoal\b)\s+(.+)$/i);
    const title = (split?.[1] ?? raw).trim();
    const goal = (split?.[2] ?? title).trim();
    const entry = await context.vault.save({
      namespace: "knowledge",
      kind: "project",
      title: titleFromContent(title),
      content: goal,
      summary: titleFromContent(goal),
      tags: ["project"],
      data: { status: "active", priority: 3, currentGoal: goal },
    });
    return result(context, "Saved the project. Plan can use its goal.", { action: "saved", entries: [preview(entry)] });
  }

  const addInbox = message.match(/^add inbox\s+(.+)/i);
  if (addInbox) {
    const content = addInbox[1].trim();
    const summary = titleFromContent(content);
    const entry = await context.vault.save({
      namespace: "knowledge",
      kind: "inbox_item",
      title: summary,
      content,
      summary,
      tags: ["inbox"],
      data: {
        priority: 2,
        source: "manual",
        summary,
        reason: content,
        recommendedAction: "Review and decide the next action.",
      },
    });
    return result(context, "Saved the inbox item.", { action: "saved", entries: [preview(entry)] });
  }

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
      { phrases: ["add task", "done task", "add project", "block project", "project status", "add inbox", "capture raw", "remember", "remember that", "save a note", "save note", "update entry", "forget", "forget entry"], weight: 10 },
      { phrases: ["what do you know about", "search vault", "search the vault", "show my notes", "open vault"], weight: 8 },
    ],
    execute: executeVault,
  };
}
