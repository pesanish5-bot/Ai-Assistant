import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActionLog, ActionLogMethod } from "./actionLog.ts";

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
 * Optional blocking channel for tests. Production uses stamp-based trusted writes
 * (`enableTrustedWrites` + `decideWrite`) so the open loopback UI cannot approve.
 */
export interface TrustedWriteConfirmationChannel {
  confirm(request: Readonly<PermissionRequest>): Promise<boolean>;
}

export type WriteApprovalMethod = "authenticated_ui" | "voice";

export interface WriteDecisionInput {
  challengeId: string;
  approve: boolean;
  method: WriteApprovalMethod;
  speakerVerified?: boolean;
}

export interface WriteDecisionResult {
  challenge: PermissionChallenge;
  stamped: boolean;
}

export interface PermissionServiceOptions {
  trustedWriteChannel?: TrustedWriteConfirmationChannel;
  /** When true, write tools create bound challenges that only a trusted stamp can unlock. */
  enableTrustedWrites?: boolean;
  actionLog?: ActionLog;
  onWriteChallenge?: (challenge: PermissionChallenge) => void;
}

interface PermissionDocument {
  version: 1;
  grants: PermissionGrant[];
}

interface WriteStamp {
  challenge: PermissionChallenge;
  method: WriteApprovalMethod;
  speakerVerified: boolean;
  approved: boolean;
  stampedAt: string;
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

function isPermissionServiceOptions(
  value: TrustedWriteConfirmationChannel | PermissionServiceOptions | undefined,
): value is PermissionServiceOptions {
  return !!value && typeof value === "object" && !("confirm" in value && typeof value.confirm === "function");
}

export class PermissionService {
  private readonly pending = new Map<string, PermissionChallenge>();
  private readonly writeStamps = new Map<string, WriteStamp>();
  private readonly store: PermissionGrantStore;
  private readonly challengeLifetimeMs: number;
  private readonly trustedWriteChannel?: TrustedWriteConfirmationChannel;
  private readonly enableTrustedWrites: boolean;
  private readonly actionLog?: ActionLog;
  private readonly onWriteChallenge?: (challenge: PermissionChallenge) => void;

  constructor(
    store: PermissionGrantStore,
    challengeLifetimeMs = 5 * 60 * 1000,
    trustedWriteChannelOrOptions?: TrustedWriteConfirmationChannel | PermissionServiceOptions,
  ) {
    this.store = store;
    this.challengeLifetimeMs = challengeLifetimeMs;
    if (isPermissionServiceOptions(trustedWriteChannelOrOptions)) {
      this.trustedWriteChannel = trustedWriteChannelOrOptions.trustedWriteChannel;
      this.enableTrustedWrites = trustedWriteChannelOrOptions.enableTrustedWrites === true;
      this.actionLog = trustedWriteChannelOrOptions.actionLog;
      this.onWriteChallenge = trustedWriteChannelOrOptions.onWriteChallenge;
    } else {
      this.trustedWriteChannel = trustedWriteChannelOrOptions;
      this.enableTrustedWrites = false;
    }
  }

  private createChallenge(request: PermissionRequest): PermissionChallenge {
    const createdAt = new Date();
    return {
      ...request,
      id: randomUUID(),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.challengeLifetimeMs).toISOString(),
    };
  }

  private async logAction(
    challenge: PermissionChallenge,
    decision: "approved" | "denied" | "expired" | "mismatch" | "rejected",
    method: ActionLogMethod,
    speakerVerified?: boolean,
  ): Promise<void> {
    if (!this.actionLog) return;
    await this.actionLog.append({
      timestamp: new Date().toISOString(),
      toolName: challenge.toolName,
      scope: challenge.scope,
      risk: challenge.risk,
      inputDigest: challenge.inputDigest,
      requestFingerprint: challenge.requestFingerprint,
      challengeId: challenge.id,
      decision,
      method,
      ...(speakerVerified !== undefined ? { speakerVerified } : {}),
    });
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

  private async consumeTrustedWriteConfirmation(
    request: PermissionRequest,
    confirmation: PermissionConfirmation,
  ): Promise<void> {
    const stamp = this.writeStamps.get(confirmation.id);
    const pending = this.pending.get(confirmation.id);
    const challenge = stamp?.challenge ?? pending;
    if (!challenge) {
      await this.logAction(
        { ...request, id: confirmation.id, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() },
        "mismatch",
        "none",
      );
      throw new PermissionConfirmationError("Unknown permission confirmation.");
    }

    this.pending.delete(confirmation.id);
    this.writeStamps.delete(confirmation.id);

    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      await this.logAction(challenge, "expired", stamp?.method ?? "none", stamp?.speakerVerified);
      throw new PermissionConfirmationError("Permission confirmation expired.");
    }
    if (!sameBinding(challenge, request)) {
      await this.logAction(challenge, "mismatch", stamp?.method ?? "none", stamp?.speakerVerified);
      throw new PermissionConfirmationError(
        "Permission confirmation did not match this tool invocation. Request permission again.",
      );
    }
    if (!stamp || !stamp.approved) {
      await this.logAction(challenge, "rejected", stamp?.method ?? "none", stamp?.speakerVerified);
      throw new PermissionConfirmationError(
        "Write confirmation must come from the trusted confirmation channel.",
      );
    }
    await this.logAction(challenge, "approved", stamp.method, stamp.speakerVerified);
  }

  /**
   * Token-authenticated write decisions only. Voice may approve reversible writes
   * when speaker verification passed; consequential writes require authenticated UI.
   */
  async decideWrite(input: WriteDecisionInput): Promise<WriteDecisionResult> {
    if (!this.enableTrustedWrites) {
      throw new TrustedWriteConfirmationRequiredError();
    }
    const challenge = this.pending.get(input.challengeId);
    if (!challenge) {
      throw new PermissionConfirmationError("Unknown permission confirmation.");
    }
    if (challenge.risk === "read") {
      throw new PermissionConfirmationError("Trusted write decisions cannot stamp read challenges.");
    }
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      this.pending.delete(challenge.id);
      await this.logAction(challenge, "expired", input.method, input.speakerVerified === true);
      throw new PermissionConfirmationError("Permission confirmation expired.");
    }
    if (input.method === "voice") {
      if (challenge.risk !== "reversible_write") {
        await this.logAction(challenge, "rejected", "voice", input.speakerVerified === true);
        throw new PermissionConfirmationError(
          "Voice approval is only allowed for reversible writes.",
        );
      }
      if (input.speakerVerified !== true) {
        await this.logAction(challenge, "rejected", "voice", false);
        throw new PermissionConfirmationError(
          "Voice approval requires speaker verification for this session.",
        );
      }
    }

    if (!input.approve) {
      const existing = this.writeStamps.get(challenge.id);
      if (existing?.approved) {
        // A prior trusted approval wins over a later deny (e.g. voice yes, then dialog No).
        return { challenge, stamped: true };
      }
      this.pending.delete(challenge.id);
      this.writeStamps.delete(challenge.id);
      await this.logAction(challenge, "denied", input.method, input.speakerVerified === true);
      return { challenge, stamped: false };
    }

    this.writeStamps.set(challenge.id, {
      challenge,
      method: input.method,
      speakerVerified: input.speakerVerified === true,
      approved: true,
      stampedAt: new Date().toISOString(),
    });
    return { challenge, stamped: true };
  }

  peekChallenge(challengeId: string): PermissionChallenge | undefined {
    return this.pending.get(challengeId);
  }

  async require(
    request: PermissionRequest,
    confirmation?: PermissionConfirmation,
  ): Promise<void> {
    if (request.risk !== "read") {
      if (this.trustedWriteChannel) {
        if (!(await this.trustedWriteChannel.confirm(Object.freeze({ ...request })))) {
          throw new PermissionConfirmationError("The trusted confirmation channel denied this write.");
        }
        return;
      }
      if (!this.enableTrustedWrites) throw new TrustedWriteConfirmationRequiredError();

      if (confirmation) {
        await this.consumeTrustedWriteConfirmation(request, confirmation);
        return;
      }

      const challenge = this.createChallenge(request);
      this.pending.set(challenge.id, challenge);
      try {
        this.onWriteChallenge?.(challenge);
      } catch {
        // HUD / native prompt notification is best-effort; the challenge remains authoritative.
      }
      throw new PermissionRequiredError(challenge);
    }

    const grants = await this.store.list();
    if (grants.some((grant) => grant.scope === request.scope)) return;

    if (confirmation) {
      await this.consumeReadConfirmation(request, confirmation);
      return;
    }

    const challenge = this.createChallenge(request);
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
