import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export type VaultLayer = "raw" | "wiki" | "outputs";
export type VaultNamespace = "memory" | "knowledge";

export type VaultEntryKind =
  | "profile"
  | "project"
  | "task"
  | "note"
  | "raw_capture"
  | "inbox_item"
  | "calendar_event"
  | "daily_plan"
  | "briefing"
  | "inbox_brief"
  | "trend_snapshot"
  | "trend_report"
  | "metric_snapshot"
  | "metrics_report"
  | "research"
  | "decision"
  | "draft";

export interface VaultEntry<TData extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  slug: string;
  layer: VaultLayer;
  namespace: VaultNamespace;
  kind: VaultEntryKind;
  type: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  data: TData;
  createdAt: string;
  updatedAt: string;
  filePath: string;
}

export interface CreateVaultEntry<TData extends Record<string, unknown> = Record<string, unknown>> {
  namespace: VaultNamespace;
  kind: VaultEntryKind;
  title: string;
  summary?: string;
  content?: string;
  tags?: string[];
  data?: TData;
  wikilinks?: string[];
}

export interface RawCaptureInput<TData extends Record<string, unknown> = Record<string, unknown>> {
  title: string;
  content: string;
  summary: string;
  tags?: string[];
  type?: string;
  kind?: VaultEntryKind;
  data?: TData;
  wikilinks?: string[];
}

export interface WikiPageInput<TData extends Record<string, unknown> = Record<string, unknown>> {
  title: string;
  content: string;
  summary: string;
  slug?: string;
  tags?: string[];
  type?: string;
  kind?: VaultEntryKind;
  namespace?: VaultNamespace;
  data?: TData;
  wikilinks?: string[];
}

export interface OutputInput<TData extends Record<string, unknown> = Record<string, unknown>> {
  title: string;
  topic: string;
  type: string;
  kind: VaultEntryKind;
  content: string;
  summary: string;
  tags?: string[];
  data?: TData;
  wikilinks?: string[];
}

export interface VaultQuery {
  layer?: VaultLayer;
  namespace?: VaultNamespace;
  kind?: VaultEntryKind;
  type?: string;
  text?: string;
  tags?: string[];
  limit?: number;
}

export interface VaultValidationIssue {
  filePath: string;
  messages: string[];
}

export interface Vault {
  initialize(): Promise<void>;
  captureRaw<TData extends Record<string, unknown>>(input: RawCaptureInput<TData>): Promise<VaultEntry<TData>>;
  upsertWiki<TData extends Record<string, unknown>>(input: WikiPageInput<TData>): Promise<VaultEntry<TData>>;
  writeOutput<TData extends Record<string, unknown>>(input: OutputInput<TData>): Promise<VaultEntry<TData>>;
  readPage(slug: string): Promise<VaultEntry | null>;
  addWikilinks(id: string, wikilinks: string[]): Promise<VaultEntry | null>;
  rebuildIndex(): Promise<void>;
  appendChange(message: string): Promise<void>;
  validateAll(): Promise<VaultValidationIssue[]>;
  save<TData extends Record<string, unknown>>(input: CreateVaultEntry<TData>): Promise<VaultEntry<TData>>;
  update<TData extends Record<string, unknown>>(
    id: string,
    changes: Partial<Pick<VaultEntry<TData>, "title" | "summary" | "content" | "tags" | "data">>,
  ): Promise<VaultEntry<TData> | null>;
  get(id: string): Promise<VaultEntry | null>;
  remove(id: string): Promise<boolean>;
  search(query?: VaultQuery): Promise<VaultEntry[]>;
  latest(kind: VaultEntryKind, namespace?: VaultNamespace): Promise<VaultEntry | null>;
}

interface Frontmatter {
  title: string;
  type: string;
  tags: string[];
  created: string;
  updated: string;
  summary: string;
  id: string;
  namespace: VaultNamespace;
  kind: VaultEntryKind;
  data: Record<string, unknown>;
}

const REQUIRED_FRONTMATTER = ["title", "type", "tags", "created", "updated", "summary"] as const;
const OUTPUT_KINDS = new Set<VaultEntryKind>([
  "daily_plan",
  "briefing",
  "inbox_brief",
  "trend_snapshot",
  "trend_report",
  "metric_snapshot",
  "metrics_report",
  "research",
  "decision",
  "draft",
]);
const RAW_KINDS = new Set<VaultEntryKind>(["raw_capture", "inbox_item", "calendar_event"]);
const SEARCH_STOP_WORDS = new Set(["a", "an", "about", "my", "please", "the"]);

const AGENT_RULES = `# Ultron Vault Rules

This vault is the canonical human-readable persistent memory system for Ultron.

Before writing persistent memory, follow these rules:

1. Persistent knowledge is Markdown.
2. Every page in \`raw/\`, \`wiki/\`, and \`outputs/\` must have the required YAML frontmatter.
3. Raw captures belong in \`raw/\`.
4. Distilled canonical knowledge belongs in \`wiki/\`.
5. Skill-generated artifacts belong in \`outputs/\`.
6. Skill outputs use dated filenames.
7. Related pages should use \`[[wikilinks]]\`.
8. Search for an existing canonical wiki page before creating a new one.
9. Update \`INDEX.md\` after meaningful additions or changes.
10. Append meaningful changes to \`CHANGELOG.md\`.
11. Do not overwrite historical outputs.
12. Do not silently write persistent memory outside this vault.
13. Preserve \`created\` when updating a page and advance \`updated\` only for meaningful edits.
14. Never store credentials, passwords, OTPs, tokens, or raw microphone recordings here.
15. The configured Vault may live at \`.ultron/vault/\`; other \`.ultron/\` data is non-knowledge runtime state.
`;

const INDEX_HEADER = `# Vault Index

This index is generated deterministically from page frontmatter. Edit the pages, then rebuild the index.
`;

const CHANGELOG_HEADER = `# Vault Changelog

This file is an append-only record of meaningful vault changes.
`;

export class VaultValidationError extends Error {
  readonly messages: string[];

  constructor(messages: string[]) {
    super(messages.join(" "));
    this.name = "VaultValidationError";
    this.messages = messages;
  }
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function summaryFrom(content: string, fallback: string): string {
  const first = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  const value = first || fallback;
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

function searchTerms(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((term) => (term.length > 4 && term.endsWith("s") ? term.slice(0, -1) : term))
    .filter((term) => term && !SEARCH_STOP_WORDS.has(term));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function encodeScalar(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed;
  }
}

function formatDocument(metadata: Frontmatter, body: string): string {
  const lines = [
    "---",
    `title: ${encodeScalar(metadata.title)}`,
    `type: ${encodeScalar(metadata.type)}`,
    "tags:",
    ...metadata.tags.map((tag) => `  - ${encodeScalar(tag)}`),
    `created: ${encodeScalar(metadata.created)}`,
    `updated: ${encodeScalar(metadata.updated)}`,
    `summary: ${encodeScalar(metadata.summary)}`,
    `id: ${encodeScalar(metadata.id)}`,
    `namespace: ${encodeScalar(metadata.namespace)}`,
    `kind: ${encodeScalar(metadata.kind)}`,
    `data: ${encodeScalar(metadata.data)}`,
    "---",
    "",
    body.trimEnd(),
    "",
  ];
  return lines.join("\n");
}

export function parseVaultMarkdown(source: string, filePath = "vault page"): { metadata: Frontmatter; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const messages: string[] = [];
  if (lines[0] !== "---") throw new VaultValidationError([`${filePath}: missing opening YAML frontmatter delimiter.`]);
  const closing = lines.indexOf("---", 1);
  if (closing < 0) throw new VaultValidationError([`${filePath}: missing closing YAML frontmatter delimiter.`]);

  const values: Record<string, unknown> = {};
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const match = line.match(/^([a-z][a-z0-9_-]*):(?:\s*(.*))?$/i);
    if (!match) {
      messages.push(`${filePath}: malformed frontmatter line ${index + 1}.`);
      continue;
    }
    const [, key, raw = ""] = match;
    if (Object.hasOwn(values, key)) messages.push(`${filePath}: duplicate frontmatter field ${key}.`);

    if (key === "tags" && !raw.trim()) {
      const tags: unknown[] = [];
      while (index + 1 < closing && /^\s+-\s+/.test(lines[index + 1])) {
        index += 1;
        tags.push(parseScalar(lines[index].replace(/^\s+-\s+/, "")));
      }
      values[key] = tags;
    } else {
      values[key] = parseScalar(raw);
    }
  }

  for (const field of REQUIRED_FRONTMATTER) {
    if (!Object.hasOwn(values, field)) messages.push(`${filePath}: missing required frontmatter field ${field}.`);
  }
  for (const field of ["title", "type", "created", "updated", "summary"] as const) {
    if (typeof values[field] !== "string" || !(values[field] as string).trim()) {
      messages.push(`${filePath}: ${field} must be a non-empty string.`);
    }
  }
  if (!Array.isArray(values.tags) || !values.tags.every((tag) => typeof tag === "string" && tag.trim())) {
    messages.push(`${filePath}: tags must be a list of non-empty strings.`);
  }
  for (const field of ["created", "updated"] as const) {
    if (typeof values[field] === "string" && Number.isNaN(Date.parse(values[field] as string))) {
      messages.push(`${filePath}: ${field} must be a valid ISO date or timestamp.`);
    }
  }
  if (values.data !== undefined && (!values.data || typeof values.data !== "object" || Array.isArray(values.data))) {
    messages.push(`${filePath}: data must be a YAML/JSON mapping when present.`);
  }
  if (messages.length) throw new VaultValidationError(messages);

  const fallbackId = slugify(String(values.title));
  const metadata: Frontmatter = {
    title: String(values.title),
    type: String(values.type),
    tags: normalizeTags(values.tags as string[]),
    created: String(values.created),
    updated: String(values.updated),
    summary: String(values.summary),
    id: typeof values.id === "string" && values.id.trim() ? values.id : fallbackId,
    namespace: values.namespace === "memory" ? "memory" : "knowledge",
    kind: (typeof values.kind === "string" ? values.kind : "note") as VaultEntryKind,
    data: (values.data ?? {}) as Record<string, unknown>,
  };
  return { metadata, body: lines.slice(closing + 1).join("\n").trim() };
}

function mergeWikilinks(content: string, wikilinks: string[] | undefined): string {
  const targets = [...new Set((wikilinks ?? []).map(slugify).filter(Boolean))].sort();
  if (!targets.length) return content.trim();
  const existing = new Set([...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => slugify(match[1])));
  const additions = targets.filter((target) => !existing.has(target));
  if (!additions.length) return content.trim();
  return `${content.trim()}\n\n## Related\n\n${additions.map((target) => `- [[${target}]]`).join("\n")}`.trim();
}

function matchesText(entry: VaultEntry, text: string): boolean {
  const haystack = [
    entry.title,
    entry.summary,
    entry.type,
    entry.kind,
    entry.content,
    entry.tags.join(" "),
    JSON.stringify(entry.data),
  ].join(" ").toLowerCase();
  const normalizedQuery = text.trim().toLowerCase();
  if (!normalizedQuery) return true;
  if (haystack.includes(normalizedQuery)) return true;
  const queryTerms = searchTerms(text);
  const haystackTerms = new Set(searchTerms(haystack));
  return queryTerms.length > 0 && queryTerms.every((term) => haystackTerms.has(term));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listMarkdownFiles(resolved)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(resolved);
  }
  return files.sort();
}

function typeForKind(kind: VaultEntryKind): string {
  const types: Partial<Record<VaultEntryKind, string>> = {
    profile: "wiki",
    project: "project-note",
    task: "project-note",
    note: "wiki",
    raw_capture: "raw",
    inbox_item: "raw",
    calendar_event: "raw",
    daily_plan: "daily-plan",
    briefing: "morning-brief",
    inbox_brief: "inbox-brief",
    trend_snapshot: "trend-report",
    trend_report: "trend-report",
    metric_snapshot: "metrics-report",
    metrics_report: "metrics-report",
  };
  return types[kind] ?? kind.replaceAll("_", "-");
}

export class MarkdownVault implements Vault {
  readonly rootDir: string;
  private readonly now: () => Date;
  private readonly timezone: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string, options: { now?: () => Date; timezone?: string } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.now = options.now ?? (() => new Date());
    this.timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  }

  private layerDir(layer: VaultLayer): string {
    return path.join(this.rootDir, layer);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureInitialized(): Promise<void> {
    await Promise.all((["raw", "wiki", "outputs"] as VaultLayer[]).map((layer) => mkdir(this.layerDir(layer), { recursive: true })));
    const initialFiles: Array<[string, string]> = [
      [path.join(this.rootDir, "INDEX.md"), `${INDEX_HEADER}\n## Wiki\n\n- _No wiki pages yet._\n\n## Recent Outputs\n\n- _No outputs yet._\n\n## Raw\n\n- _No raw captures yet._\n`],
      [path.join(this.rootDir, "CHANGELOG.md"), CHANGELOG_HEADER],
      [path.join(this.rootDir, "AGENTS.md"), AGENT_RULES],
    ];
    for (const [filePath, content] of initialFiles) {
      if (!(await fileExists(filePath))) await atomicWrite(filePath, content);
    }
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureInitialized();
      await this.rebuildIndexDirect();
    });
  }

  private localDate(date: Date): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  private async nextDatedSlug(layer: "raw" | "outputs", topic: string, date: string): Promise<string> {
    const base = `${date}-${slugify(topic)}`;
    let candidate = base;
    let sequence = 2;
    while (await fileExists(path.join(this.layerDir(layer), `${candidate}.md`))) {
      candidate = `${base}-${String(sequence).padStart(2, "0")}`;
      sequence += 1;
    }
    return candidate;
  }

  private async appendChangeDirect(message: string, timestamp = this.now().toISOString()): Promise<void> {
    await appendFile(path.join(this.rootDir, "CHANGELOG.md"), `\n## ${timestamp}\n\n- ${message.trim()}\n`, "utf8");
  }

  async appendChange(message: string): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureInitialized();
      await this.appendChangeDirect(message);
    });
  }

  private async readEntry(filePath: string, layer: VaultLayer): Promise<VaultEntry> {
    const source = await readFile(filePath, "utf8");
    const { metadata, body } = parseVaultMarkdown(source, filePath);
    const slug = path.basename(filePath, path.extname(filePath));
    return {
      id: metadata.id || slug,
      slug,
      layer,
      namespace: metadata.namespace,
      kind: metadata.kind,
      type: metadata.type,
      title: metadata.title,
      summary: metadata.summary,
      content: body,
      tags: metadata.tags,
      data: metadata.data,
      createdAt: metadata.created,
      updatedAt: metadata.updated,
      filePath,
    };
  }

  private async readAllDirect(): Promise<VaultEntry[]> {
    const pages: VaultEntry[] = [];
    for (const layer of ["raw", "wiki", "outputs"] as VaultLayer[]) {
      for (const filePath of await listMarkdownFiles(this.layerDir(layer))) {
        pages.push(await this.readEntry(filePath, layer));
      }
    }
    return pages;
  }

  private async findDirect(idOrSlug: string): Promise<VaultEntry | null> {
    const normalized = slugify(idOrSlug);
    const pages = await this.readAllDirect();
    return pages.find((page) => page.id === idOrSlug || page.slug === idOrSlug || page.slug === normalized) ?? null;
  }

  private metadataFor<TData extends Record<string, unknown>>(input: {
    id: string;
    namespace: VaultNamespace;
    kind: VaultEntryKind;
    type: string;
    title: string;
    summary: string;
    tags?: string[];
    data?: TData;
    created: string;
    updated: string;
  }): Frontmatter {
    return {
      title: input.title.trim(),
      type: input.type.trim(),
      tags: normalizeTags(input.tags),
      created: input.created,
      updated: input.updated,
      summary: input.summary.trim(),
      id: input.id,
      namespace: input.namespace,
      kind: input.kind,
      data: input.data ?? {},
    };
  }

  async captureRaw<TData extends Record<string, unknown>>(input: RawCaptureInput<TData>): Promise<VaultEntry<TData>> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const current = this.now();
      const timestamp = current.toISOString();
      const slug = await this.nextDatedSlug("raw", input.title, this.localDate(current));
      const filePath = path.join(this.layerDir("raw"), `${slug}.md`);
      const body = mergeWikilinks(input.content, input.wikilinks);
      const metadata = this.metadataFor({
        id: slug,
        namespace: "knowledge",
        kind: input.kind ?? "raw_capture",
        type: input.type ?? "raw",
        title: input.title,
        summary: input.summary,
        tags: input.tags,
        data: input.data,
        created: timestamp,
        updated: timestamp,
      });
      await atomicWrite(filePath, formatDocument(metadata, body));
      await this.appendChangeDirect(`Created raw capture [[${slug}]] — ${metadata.summary}`, timestamp);
      await this.rebuildIndexDirect();
      return (await this.readEntry(filePath, "raw")) as VaultEntry<TData>;
    });
  }

  async upsertWiki<TData extends Record<string, unknown>>(input: WikiPageInput<TData>): Promise<VaultEntry<TData>> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const slug = slugify(input.slug ?? input.title);
      const filePath = path.join(this.layerDir("wiki"), `${slug}.md`);
      const timestamp = this.now().toISOString();
      const existing = await fileExists(filePath) ? await this.readEntry(filePath, "wiki") : null;
      const body = mergeWikilinks(input.content, input.wikilinks);
      const metadata = this.metadataFor({
        id: existing?.id ?? slug,
        namespace: input.namespace ?? existing?.namespace ?? "memory",
        kind: input.kind ?? existing?.kind ?? "note",
        type: input.type ?? existing?.type ?? "wiki",
        title: input.title,
        summary: input.summary,
        tags: input.tags ?? existing?.tags,
        data: input.data ?? (existing?.data as TData | undefined),
        created: existing?.createdAt ?? timestamp,
        updated: timestamp,
      });
      const formatted = formatDocument(metadata, body);
      if (existing && formatted === formatDocument({
        title: existing.title,
        type: existing.type,
        tags: existing.tags,
        created: existing.createdAt,
        updated: timestamp,
        summary: existing.summary,
        id: existing.id,
        namespace: existing.namespace,
        kind: existing.kind,
        data: existing.data,
      }, existing.content)) return existing as VaultEntry<TData>;

      await atomicWrite(filePath, formatted);
      await this.appendChangeDirect(`${existing ? "Updated" : "Created"} [[${slug}]] — ${metadata.summary}`, timestamp);
      await this.rebuildIndexDirect();
      return (await this.readEntry(filePath, "wiki")) as VaultEntry<TData>;
    });
  }

  async writeOutput<TData extends Record<string, unknown>>(input: OutputInput<TData>): Promise<VaultEntry<TData>> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const current = this.now();
      const timestamp = current.toISOString();
      const slug = await this.nextDatedSlug("outputs", input.topic, this.localDate(current));
      const filePath = path.join(this.layerDir("outputs"), `${slug}.md`);
      const body = mergeWikilinks(input.content, input.wikilinks);
      const metadata = this.metadataFor({
        id: slug,
        namespace: "knowledge",
        kind: input.kind,
        type: input.type,
        title: input.title,
        summary: input.summary,
        tags: input.tags,
        data: input.data,
        created: timestamp,
        updated: timestamp,
      });
      await atomicWrite(filePath, formatDocument(metadata, body));
      await this.appendChangeDirect(`Added [[${slug}]] — ${metadata.summary}`, timestamp);
      await this.rebuildIndexDirect();
      return (await this.readEntry(filePath, "outputs")) as VaultEntry<TData>;
    });
  }

  async readPage(slug: string): Promise<VaultEntry | null> {
    await this.writeQueue;
    await this.ensureInitialized();
    return this.findDirect(slug);
  }

  async addWikilinks(id: string, wikilinks: string[]): Promise<VaultEntry | null> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const entry = await this.findDirect(id);
      if (!entry) return null;
      const content = mergeWikilinks(entry.content, wikilinks);
      if (content === entry.content) return entry;
      const timestamp = this.now().toISOString();
      const metadata = this.metadataFor({
        id: entry.id,
        namespace: entry.namespace,
        kind: entry.kind,
        type: entry.type,
        title: entry.title,
        summary: entry.summary,
        tags: entry.tags,
        data: entry.data,
        created: entry.createdAt,
        updated: timestamp,
      });
      await atomicWrite(entry.filePath, formatDocument(metadata, content));
      await this.appendChangeDirect(`Updated [[${entry.slug}]] with related-page links.`, timestamp);
      await this.rebuildIndexDirect();
      return this.readEntry(entry.filePath, entry.layer);
    });
  }

  private async rebuildIndexDirect(): Promise<void> {
    const pages = await this.readAllDirect();
    const sections: Array<[string, VaultEntry[]]> = [
      ["Wiki", pages.filter((page) => page.layer === "wiki").sort((a, b) => a.slug.localeCompare(b.slug))],
      ["Recent Outputs", pages.filter((page) => page.layer === "outputs").sort((a, b) => b.slug.localeCompare(a.slug))],
      ["Raw", pages.filter((page) => page.layer === "raw").sort((a, b) => b.slug.localeCompare(a.slug))],
    ];
    const content = [
      INDEX_HEADER.trimEnd(),
      ...sections.flatMap(([title, entries]) => [
        "",
        `## ${title}`,
        "",
        ...(entries.length ? entries.map((entry) => `- [[${entry.slug}]] — ${entry.summary}`) : [`- _No ${title.toLowerCase()} yet._`]),
      ]),
      "",
    ].join("\n");
    await atomicWrite(path.join(this.rootDir, "INDEX.md"), content);
  }

  async rebuildIndex(): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureInitialized();
      await this.rebuildIndexDirect();
    });
  }

  async validateAll(): Promise<VaultValidationIssue[]> {
    await this.writeQueue;
    await this.ensureInitialized();
    const issues: VaultValidationIssue[] = [];
    for (const layer of ["raw", "wiki", "outputs"] as VaultLayer[]) {
      for (const filePath of await listMarkdownFiles(this.layerDir(layer))) {
        try {
          parseVaultMarkdown(await readFile(filePath, "utf8"), filePath);
        } catch (error) {
          issues.push({
            filePath,
            messages: error instanceof VaultValidationError ? error.messages : [error instanceof Error ? error.message : "Unknown validation failure."],
          });
        }
      }
    }
    return issues;
  }

  async save<TData extends Record<string, unknown>>(input: CreateVaultEntry<TData>): Promise<VaultEntry<TData>> {
    const content = input.content?.trim() ?? "";
    const summary = input.summary?.trim() || summaryFrom(content, input.title);
    if (OUTPUT_KINDS.has(input.kind)) {
      return this.writeOutput({
        title: input.title,
        topic: input.kind.replaceAll("_", "-"),
        type: typeForKind(input.kind),
        kind: input.kind,
        content,
        summary,
        tags: input.tags,
        data: input.data,
        wikilinks: input.wikilinks,
      });
    }
    if (RAW_KINDS.has(input.kind)) {
      return this.captureRaw({
        title: input.title,
        content,
        summary,
        type: typeForKind(input.kind),
        kind: input.kind,
        tags: input.tags,
        data: input.data,
        wikilinks: input.wikilinks,
      });
    }
    return this.upsertWiki({
      title: input.title,
      content,
      summary,
      type: typeForKind(input.kind),
      kind: input.kind,
      namespace: input.namespace,
      tags: input.tags,
      data: input.data,
      wikilinks: input.wikilinks,
    });
  }

  async update<TData extends Record<string, unknown>>(
    id: string,
    changes: Partial<Pick<VaultEntry<TData>, "title" | "summary" | "content" | "tags" | "data">>,
  ): Promise<VaultEntry<TData> | null> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const existing = await this.findDirect(id);
      if (!existing || existing.layer !== "wiki") return null;
      const timestamp = this.now().toISOString();
      const metadata = this.metadataFor({
        id: existing.id,
        namespace: existing.namespace,
        kind: existing.kind,
        type: existing.type,
        title: changes.title ?? existing.title,
        summary: changes.summary ?? existing.summary,
        tags: changes.tags ?? existing.tags,
        data: changes.data ?? (existing.data as TData),
        created: existing.createdAt,
        updated: timestamp,
      });
      const body = changes.content ?? existing.content;
      const unchanged =
        metadata.title === existing.title &&
        metadata.summary === existing.summary &&
        JSON.stringify(metadata.tags) === JSON.stringify(existing.tags) &&
        JSON.stringify(stableValue(metadata.data)) === JSON.stringify(stableValue(existing.data)) &&
        body.trim() === existing.content.trim();
      if (unchanged) return existing as VaultEntry<TData>;
      await atomicWrite(existing.filePath, formatDocument(metadata, body));
      await this.appendChangeDirect(`Updated [[${existing.slug}]] — ${metadata.summary}`, timestamp);
      await this.rebuildIndexDirect();
      return (await this.readEntry(existing.filePath, "wiki")) as VaultEntry<TData>;
    });
  }

  async get(id: string): Promise<VaultEntry | null> {
    return this.readPage(id);
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const entry = await this.findDirect(id);
      if (!entry) return false;
      await unlink(entry.filePath);
      const timestamp = this.now().toISOString();
      await this.appendChangeDirect(`Removed [[${entry.slug}]] by explicit request.`, timestamp);
      await this.rebuildIndexDirect();
      return true;
    });
  }

  async search(query: VaultQuery = {}): Promise<VaultEntry[]> {
    await this.writeQueue;
    await this.ensureInitialized();
    const requiredTags = normalizeTags(query.tags);
    return (await this.readAllDirect())
      .filter((entry) => !query.layer || entry.layer === query.layer)
      .filter((entry) => !query.namespace || entry.namespace === query.namespace)
      .filter((entry) => !query.kind || entry.kind === query.kind)
      .filter((entry) => !query.type || entry.type === query.type)
      .filter((entry) => !query.text || matchesText(entry, query.text))
      .filter((entry) => requiredTags.every((tag) => entry.tags.includes(tag)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.slug.localeCompare(right.slug))
      .slice(0, query.limit ?? 100);
  }

  async latest(kind: VaultEntryKind, namespace?: VaultNamespace): Promise<VaultEntry | null> {
    return (await this.search({ kind, namespace, limit: 1 }))[0] ?? null;
  }
}
