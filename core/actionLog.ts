import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { PermissionRisk } from "./permissions.ts";

export type ActionLogDecision = "approved" | "denied" | "expired" | "mismatch" | "rejected";
export type ActionLogMethod = "authenticated_ui" | "voice" | "none";

export interface ActionLogEntry {
  timestamp: string;
  toolName: string;
  scope: string;
  risk: PermissionRisk;
  inputDigest: string;
  requestFingerprint: string;
  challengeId: string;
  decision: ActionLogDecision;
  method: ActionLogMethod;
  speakerVerified?: boolean;
}

export interface ActionLog {
  append(entry: ActionLogEntry): Promise<void>;
}

/** Append-only NDJSON audit trail for write approvals and denials. */
export class AppendOnlyActionLog implements ActionLog {
  private readonly filePath: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "state", "actions.log");
  }

  async append(entry: ActionLogEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.chain = this.chain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, { encoding: "utf8", flag: "a" });
    });
    await this.chain;
  }
}

export class MemoryActionLog implements ActionLog {
  readonly entries: ActionLogEntry[] = [];

  async append(entry: ActionLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}
