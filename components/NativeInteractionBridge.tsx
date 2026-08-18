"use client";

import { useEffect, useRef } from "react";
import { faceController } from "@/interaction/face/faceController";
import { interactionEventBus } from "@/interaction/events";

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
    case "voice.speaking":
      interactionEventBus.emit({
        type: event.name,
        timestamp,
        payload: { active: event.payload.active === true },
      });
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
                : "unknown",
        },
      });
      faceController.setState("error");
  }
}

/** Polls only coarse HUD events; authentication audio and scores never enter the browser. */
export default function NativeInteractionBridge() {
  const seenSequence = useRef(0);
  const seenGeneration = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let polling = false;
    let activeController: AbortController | null = null;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 2_000);
      try {
        const query = new URLSearchParams({ after: String(seenSequence.current) });
        if (seenGeneration.current) query.set("generation", seenGeneration.current);
        const response = await fetch(`/api/interaction?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const snapshot = (await response.json()) as BridgeSnapshot;
        if (seenGeneration.current !== snapshot.generation) {
          seenGeneration.current = snapshot.generation;
          seenSequence.current = 0;
        }
        if (
          !disposed &&
          snapshot.sequence > seenSequence.current
        ) {
          for (const event of snapshot.events ?? (snapshot.event ? [snapshot.event] : [])) {
            projectNativeEvent(event);
          }
          seenSequence.current = snapshot.sequence;
        }
      } catch {
        // The native bridge is optional while Ultron runs in text-only mode.
      } finally {
        window.clearTimeout(timeout);
        if (activeController === controller) activeController = null;
        polling = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 350);
    return () => {
      disposed = true;
      activeController?.abort();
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
