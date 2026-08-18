import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type PermissionRisk = "read" | "reversible_write" | "consequential_write";

export interface PermissionRequest {
  scope: string;
  toolName: string;
  description: string;
  risk: PermissionRisk;
  inputDigest: string;
  requestFingerprint: string;
}

export interface PermissionChallenge extends PermissionRequest {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export interface PermissionConfirmation {
  id: string;
  remember: boolean;
}

export interface PermissionGrant {
  scope: string;
  grantedAt: string;
}

export interface PermissionGrantStore {
  list(): Promise<PermissionGrant[]>;
  save(grant: PermissionGrant): Promise<void>;
  remove(scope: string): Promise<boolean>;
}

/**
 * A future write-capable build must inject a separately reviewed confirmation
 * channel here. Loopback HTTP is deliberately not such a channel: another
 * process running as the same desktop user could call it without a human click.
 */
export interface TrustedWriteConfirmationChannel {
  confirm(request: Readonly<PermissionRequest>): Promise<boolean>;
}

interface PermissionDocument {
  version: 1;
  grants: PermissionGrant[];
}

function canonicalizeJson(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Tool permission inputs must contain finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Tool permission inputs must not be cyclic.");
    seen.add(value);
    try {
      return `[${value.map((item) => canonicalizeJson(item, seen)).join(",")}]`;
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Tool permission inputs must be JSON-compatible plain objects.");
    }
    if (seen.has(record)) throw new Error("Tool permission inputs must not be cyclic.");
    seen.add(record);
    try {
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key], seen)}`)
        .join(",")}}`;
    } finally {
      seen.delete(record);
    }
  }
  throw new Error("Tool permission inputs must be JSON-compatible.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestPermissionInput(input: unknown): string {
  return sha256(canonicalizeJson(input, new Set<object>()));
}

export function normalizePermissionMessage(message: string): string {
  return message.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function fingerprintPermissionMessage(message: string): string {
  return sha256(normalizePermissionMessage(message));
}

export class JsonFilePermissionGrantStore implements PermissionGrantStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "state", "permissions.json");
  }

  private async read(): Promise<PermissionDocument> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PermissionDocument>;
      if (parsed.version !== 1 || !Array.isArray(parsed.grants)) {
        throw new Error("Unsupported or malformed permission document.");
      }
      return { version: 1, grants: parsed.grants };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, grants: [] };
      throw error;
    }
  }

  private async write(document: PermissionDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }

  async list(): Promise<PermissionGrant[]> {
    return (await this.read()).grants;
  }

  async save(grant: PermissionGrant): Promise<void> {
    const document = await this.read();
    document.grants = document.grants.filter((item) => item.scope !== grant.scope);
    document.grants.push(grant);
    await this.write(document);
  }

  async remove(scope: string): Promise<boolean> {
    const document = await this.read();
    const grants = document.grants.filter((grant) => grant.scope !== scope);
    if (grants.length === document.grants.length) return false;
    await this.write({ version: 1, grants });
    return true;
  }
}

export class MemoryPermissionGrantStore implements PermissionGrantStore {
  private readonly grants = new Map<string, PermissionGrant>();

  async list(): Promise<PermissionGrant[]> {
    return [...this.grants.values()];
  }

  async save(grant: PermissionGrant): Promise<void> {
    this.grants.set(grant.scope, grant);
  }

  async remove(scope: string): Promise<boolean> {
    return this.grants.delete(scope);
  }
}

export class PermissionRequiredError extends Error {
  readonly challenge: PermissionChallenge;

  constructor(challenge: PermissionChallenge) {
    super(`Permission required for ${challenge.toolName}.`);
    this.name = "PermissionRequiredError";
    this.challenge = challenge;
  }
}

export class PermissionConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionConfirmationError";
  }
}

export class TrustedWriteConfirmationRequiredError extends Error {
  constructor() {
    super("Write tools are disabled until a trusted human-confirmation channel is configured.");
    this.name = "TrustedWriteConfirmationRequiredError";
  }
}

function sameBinding(challenge: PermissionChallenge, request: PermissionRequest): boolean {
  return (
    challenge.scope === request.scope &&
    challenge.toolName === request.toolName &&
    challenge.risk === request.risk &&
    challenge.inputDigest === request.inputDigest &&
    challenge.requestFingerprint === request.requestFingerprint
  );
}

export class PermissionService {
  private readonly pending = new Map<string, PermissionChallenge>();
  private readonly store: PermissionGrantStore;
  private readonly challengeLifetimeMs: number;
  private readonly trustedWriteChannel?: TrustedWriteConfirmationChannel;

  constructor(
    store: PermissionGrantStore,
    challengeLifetimeMs = 5 * 60 * 1000,
    trustedWriteChannel?: TrustedWriteConfirmationChannel,
  ) {
    this.store = store;
    this.challengeLifetimeMs = challengeLifetimeMs;
    this.trustedWriteChannel = trustedWriteChannel;
  }

  private async consumeReadConfirmation(
    request: PermissionRequest,
    confirmation: PermissionConfirmation,
  ): Promise<void> {
    // Get-and-delete is intentionally synchronous. Concurrent calls cannot both
    // consume the same challenge before any persistent-store await occurs.
    const challenge = this.pending.get(confirmation.id);
    if (!challenge) throw new PermissionConfirmationError("Unknown permission confirmation.");
    this.pending.delete(confirmation.id);

    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      throw new PermissionConfirmationError("Permission confirmation expired.");
    }
    if (!sameBinding(challenge, request)) {
      throw new PermissionConfirmationError(
        "Permission confirmation did not match this tool invocation. Request permission again.",
      );
    }

    if (confirmation.remember) {
      await this.store.save({ scope: request.scope, grantedAt: new Date().toISOString() });
    }
  }

  async require(
    request: PermissionRequest,
    confirmation?: PermissionConfirmation,
  ): Promise<void> {
    if (request.risk !== "read") {
      if (!this.trustedWriteChannel) throw new TrustedWriteConfirmationRequiredError();
      if (!(await this.trustedWriteChannel.confirm(Object.freeze({ ...request })))) {
        throw new PermissionConfirmationError("The trusted confirmation channel denied this write.");
      }
      return;
    }

    const grants = await this.store.list();
    if (grants.some((grant) => grant.scope === request.scope)) return;

    if (confirmation) {
      await this.consumeReadConfirmation(request, confirmation);
      return;
    }

    const createdAt = new Date();
    const challenge: PermissionChallenge = {
      ...request,
      id: randomUUID(),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.challengeLifetimeMs).toISOString(),
    };
    this.pending.set(challenge.id, challenge);
    throw new PermissionRequiredError(challenge);
  }

  async revoke(scope: string): Promise<boolean> {
    return this.store.remove(scope);
  }

  async grants(): Promise<PermissionGrant[]> {
    return this.store.list();
  }
}
