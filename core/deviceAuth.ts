import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DeviceTokenRecord {
  id: string;
  label: string;
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface DeviceTokenDocument {
  version: 1;
  tokens: DeviceTokenRecord[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function hashDeviceToken(token: string): string {
  return sha256(`ultron-device-v1:${token}`);
}

/** Generate a single-use display token; only the hash is persisted. */
export function mintDeviceToken(): { token: string; record: Omit<DeviceTokenRecord, "createdAt" | "lastUsedAt"> } {
  const token = randomBytes(32).toString("base64url");
  const id = randomBytes(8).toString("hex");
  return {
    token,
    record: {
      id,
      label: `phone-${id.slice(0, 6)}`,
      hash: hashDeviceToken(token),
    },
  };
}

export class DeviceTokenStore {
  private readonly filePath: string;
  private cache: DeviceTokenDocument | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "state", "device-tokens.json");
  }

  private async load(): Promise<DeviceTokenDocument> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<DeviceTokenDocument>;
      if (parsed.version === 1 && Array.isArray(parsed.tokens)) {
        this.cache = {
          version: 1,
          tokens: parsed.tokens.filter(
            (item): item is DeviceTokenRecord =>
              !!item
              && typeof item.id === "string"
              && typeof item.label === "string"
              && typeof item.hash === "string"
              && typeof item.createdAt === "string"
              && (item.lastUsedAt === null || typeof item.lastUsedAt === "string"),
          ),
        };
        return this.cache;
      }
    } catch {
      // Missing or corrupt file → empty store.
    }
    this.cache = { version: 1, tokens: [] };
    return this.cache;
  }

  private async save(document: DeviceTokenDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    this.cache = document;
  }

  async list(): Promise<Array<Pick<DeviceTokenRecord, "id" | "label" | "createdAt" | "lastUsedAt">>> {
    const document = await this.load();
    return document.tokens.map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
  }

  async register(label?: string): Promise<{ token: string; id: string; label: string }> {
    const minted = mintDeviceToken();
    const document = await this.load();
    const record: DeviceTokenRecord = {
      ...minted.record,
      label: label?.trim().slice(0, 40) || minted.record.label,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    document.tokens = [...document.tokens.filter((item) => item.id !== record.id), record].slice(-16);
    await this.save(document);
    return { token: minted.token, id: record.id, label: record.label };
  }

  async revoke(id: string): Promise<boolean> {
    const document = await this.load();
    const next = document.tokens.filter((item) => item.id !== id);
    if (next.length === document.tokens.length) return false;
    await this.save({ version: 1, tokens: next });
    return true;
  }

  async verify(token: string | null | undefined): Promise<boolean> {
    if (!token || token.length < 32 || token.length > 200) return false;
    const hash = hashDeviceToken(token);
    const document = await this.load();
    const match = document.tokens.find((item) => safeEqualHex(item.hash, hash));
    if (!match) return false;
    match.lastUsedAt = new Date().toISOString();
    await this.save(document);
    return true;
  }
}

const shared = globalThis as typeof globalThis & { __ultronDeviceTokens?: DeviceTokenStore };

export function getDeviceTokenStore(dataDir: string): DeviceTokenStore {
  shared.__ultronDeviceTokens ??= new DeviceTokenStore(dataDir);
  return shared.__ultronDeviceTokens;
}
