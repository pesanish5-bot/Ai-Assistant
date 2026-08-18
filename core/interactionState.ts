import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

export const SAFE_BRIDGE_EVENTS = [
  "voice.wake_detected",
  "voice.listening",
  "voice.transcribing",
  "voice.speaking",
  "clap.double_detected",
  "clap.activation_detected",
  "hud.open_requested",
  "auth.started",
  "auth.prototype_verified",
  "auth.failed",
  "activation.rejected",
] as const;

export type SafeBridgeEventName = (typeof SAFE_BRIDGE_EVENTS)[number];

export interface SafeBridgeEvent {
  name: SafeBridgeEventName;
  timestamp: number;
  payload: Record<string, string | number | boolean | null>;
}

export interface InteractionSnapshot {
  generation: string;
  sequence: number;
  event: SafeBridgeEvent | null;
  events?: SafeBridgeEvent[];
}

const SAFE_EVENT_SET = new Set<string>(SAFE_BRIDGE_EVENTS);
const SAFE_PAYLOAD_FIELDS = new Set([
  "active",
  "enter_listening",
  "interval_ms",
  "activation_method",
  "reason",
]);

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function parseSafeBridgeEvent(value: unknown): SafeBridgeEvent {
  if (!value || typeof value !== "object") throw new Error("event must be an object");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || !SAFE_EVENT_SET.has(candidate.name)) {
    throw new Error("event name is not permitted on the HUD bridge");
  }
  if (typeof candidate.timestamp !== "number" || !Number.isFinite(candidate.timestamp) || candidate.timestamp < 0) {
    throw new Error("event timestamp is invalid");
  }
  if (!candidate.payload || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)) {
    throw new Error("event payload must be an object");
  }

  const payload: Record<string, string | number | boolean | null> = {};
  for (const [key, fieldValue] of Object.entries(candidate.payload as Record<string, unknown>)) {
    if (!SAFE_PAYLOAD_FIELDS.has(key)) throw new Error(`event payload field is not permitted: ${key}`);
    if (!isScalar(fieldValue)) throw new Error(`event payload field must be scalar: ${key}`);
    payload[key] = fieldValue;
  }

  return {
    name: candidate.name as SafeBridgeEventName,
    timestamp: candidate.timestamp,
    payload,
  };
}

export function isAuthorizedInteractionToken(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected || expected.length < 32) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export class InteractionStateProjector {
  private static readonly MAX_HISTORY = 128;
  private sequence = 0;
  private readonly generation = randomUUID();
  private event: SafeBridgeEvent | null = null;
  private history: Array<{ sequence: number; event: SafeBridgeEvent }> = [];

  apply(value: unknown): InteractionSnapshot {
    this.event = parseSafeBridgeEvent(value);
    this.sequence += 1;
    this.history.push({ sequence: this.sequence, event: this.event });
    if (this.history.length > InteractionStateProjector.MAX_HISTORY) {
      this.history.splice(0, this.history.length - InteractionStateProjector.MAX_HISTORY);
    }
    return this.snapshot();
  }

  snapshot(afterSequence?: number, clientGeneration?: string | null): InteractionSnapshot {
    if (afterSequence === undefined) {
      return { generation: this.generation, sequence: this.sequence, event: this.event };
    }
    const generationMatches = clientGeneration === this.generation;
    const events = this.history
      .filter((entry) => !generationMatches || entry.sequence > afterSequence)
      .map((entry) => entry.event);
    return { generation: this.generation, sequence: this.sequence, event: events.at(-1) ?? null, events };
  }
}

let projector: InteractionStateProjector | undefined;

export function getInteractionStateProjector(): InteractionStateProjector {
  projector ??= new InteractionStateProjector();
  return projector;
}
