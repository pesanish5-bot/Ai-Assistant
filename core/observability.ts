export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  event: string;
  timestamp: string;
  fields: Record<string, unknown>;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

const SENSITIVE_FIELD = /authorization|cookie|credential|password|secret|token|otp/i;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_FIELD.test(key) ? "[REDACTED]" : sanitizeValue(item, depth + 1),
    ]),
  );
}

export class ConsoleLogger implements Logger {
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const record: LogRecord = {
      level,
      event,
      timestamp: new Date().toISOString(),
      fields: sanitizeValue(fields) as Record<string, unknown>,
    };
    const line = JSON.stringify(record);

    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  }
}

export class MemoryLogger implements Logger {
  readonly records: LogRecord[] = [];

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    this.records.push({
      level,
      event,
      timestamp: new Date().toISOString(),
      fields: sanitizeValue(fields) as Record<string, unknown>,
    });
  }
}
