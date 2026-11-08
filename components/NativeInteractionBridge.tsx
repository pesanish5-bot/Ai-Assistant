"use client";

import { useEffect, useRef } from "react";
import { faceController } from "@/interaction/face/faceController";
import { interactionEventBus } from "@/interaction/events";
import { deviceAuthHeaders } from "@/lib/deviceToken";

interface BridgeSnapshot {
  generation: string;
  sequence: number;
  events?: Array<NonNullable<BridgeSnapshot["event"]>>;
  event: {
    name: string;
    timestamp: number;
    payload: Record<string, string | number | boolean | null>;
  } | null;
}

function projectNativeEvent(event: NonNullable<BridgeSnapshot["event"]>) {
  const timestamp = event.timestamp * 1_000;
  switch (event.name) {
    case "voice.wake_detected":
      interactionEventBus.emit({
        type: "voice.wake_detected",
        timestamp,
        payload: { phrase: "Ultron" },
      });
      return;
    case "voice.listening":
    case "voice.transcribing":
    case "voice.thinking":
    case "voice.speaking":
      interactionEventBus.emit({
        type: event.name,
        timestamp,
        payload: { active: event.payload.active === true },
      });
      return;
    case "voice.audio_level":
      if (typeof event.payload.level === "number") {
        interactionEventBus.emit({
          type: "voice.audio_level",
          timestamp,
          payload: { level: event.payload.level },
        });
      }
      return;
    case "clap.double_detected":
      interactionEventBus.emit({
        type: "clap.double_detected",
        timestamp,
        payload: {
          intervalMs:
            typeof event.payload.interval_ms === "number" ? event.payload.interval_ms : 0,
        },
      });
      return;
    case "clap.activation_detected":
      interactionEventBus.emit({
        type: "clap.activation_detected",
        timestamp,
        payload: {
          clapCount: event.payload.clap_count === 2 ? 2 : 1,
          intervalMs:
            typeof event.payload.interval_ms === "number" ? event.payload.interval_ms : 0,
        },
      });
      return;
    case "hud.open_requested":
      interactionEventBus.emit({
        type: "hud.open_requested",
        timestamp,
        payload: {
          reason: "double_clap",
          enterListening: event.payload.enter_listening !== false,
        },
      });
      return;
    case "auth.started":
      interactionEventBus.emit({
        type: "auth.started",
        timestamp,
        payload: { activationMethod: "double_clap" },
      });
      return;
    case "auth.prototype_verified":
      interactionEventBus.emit({
        type: "auth.prototype_verified",
        timestamp,
        payload: {},
      });
      faceController.setSignals({ intensity: 1 });
      faceController.setState("idle");
      return;
    case "auth.failed":
      interactionEventBus.emit({
        type: "auth.failed",
        timestamp,
        payload: { reason: "unknown" },
      });
      return;
    case "activation.rejected":
      interactionEventBus.emit({
        type: "activation.rejected",
        timestamp,
        payload: {
          reason:
            event.payload.reason === "lock_state_unknown"
              ? "lock_state_unknown"
              : event.payload.reason === "microphone_unavailable"
                ? "microphone_unavailable"
                : event.payload.reason === "voice_pipeline_unavailable"
                  ? "voice_pipeline_unavailable"
                : "unknown",
        },
      });
      faceController.setState("error");
      return;
    case "activation.changed":
      interactionEventBus.emit({
        type: "activation.changed",
        timestamp,
        payload: { enabled: event.payload.enabled === true },
      });
  }
}

function applyInteractionSnapshot(
  snapshot: BridgeSnapshot,
  seenSequence: { current: number },
  seenGeneration: { current: string | null },
) {
  if (seenGeneration.current !== snapshot.generation) {
    seenGeneration.current = snapshot.generation;
    seenSequence.current = 0;
  }
  if (snapshot.sequence > seenSequence.current) {
    for (const event of snapshot.events ?? (snapshot.event ? [snapshot.event] : [])) {
      projectNativeEvent(event);
    }
    seenSequence.current = snapshot.sequence;
  }
}

/** Consumes the HUD SSE stream for coarse native events; auth audio never enters the browser. */
export default function NativeInteractionBridge() {
  const seenSequence = useRef(0);
  const seenGeneration = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | null = null;
    let buffer = "";

    const connect = async () => {
      while (!disposed) {
        const controller = new AbortController();
        activeController = controller;
        try {
          const response = await fetch("/api/hud-stream", {
            cache: "no-store",
            headers: { ...deviceAuthHeaders(), Accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
            continue;
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          buffer = "";
          while (!disposed) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let split = buffer.indexOf("\n\n");
            while (split >= 0) {
              const raw = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);
              const lines = raw.split("\n");
              let eventName = "message";
              const dataLines: string[] = [];
              for (const line of lines) {
                if (line.startsWith("event:")) eventName = line.slice(6).trim();
                if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
              }
              if (eventName === "interaction" && dataLines.length) {
                try {
                  const snapshot = JSON.parse(dataLines.join("\n")) as BridgeSnapshot;
                  if (!disposed) applyInteractionSnapshot(snapshot, seenSequence, seenGeneration);
                } catch {
                  // Ignore malformed frames.
                }
              }
              split = buffer.indexOf("\n\n");
            }
          }
        } catch {
          // Stream reconnects while Ultron runs in text-only or remote mode.
        } finally {
          if (activeController === controller) activeController = null;
        }
        if (!disposed) await new Promise((resolve) => window.setTimeout(resolve, 800));
      }
    };

    void connect();
    return () => {
      disposed = true;
      activeController?.abort();
    };
  }, []);

  return null;
}
