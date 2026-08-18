"use client";

import { useEffect, useRef, useState } from "react";
import {
  interactionEventBus,
  type CameraState,
  type FaceState,
  type GestureName,
} from "@/interaction/events";

type CoreState = "CHECKING" | "ONLINE" | "OFFLINE";
type VoiceState = "STANDBY" | "LISTENING" | "TRANSCRIBING" | "SPEAKING";

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="hud-panel-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function HudStatusPanels() {
  const [clock, setClock] = useState("--:--:--");
  const [core, setCore] = useState<CoreState>("CHECKING");
  const [face, setFace] = useState<FaceState>("idle");
  const [camera, setCamera] = useState<CameraState>("disabled");
  const [gesture, setGesture] = useState<GestureName | "standby">("standby");
  const [voice, setVoice] = useState<VoiceState>("STANDBY");
  const [activation, setActivation] = useState("MANUAL");
  const gestureTimer = useRef<number | null>(null);

  useEffect(() => {
    const updateClock = () =>
      setClock(
        new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date()),
      );
    updateClock();
    const interval = window.setInterval(updateClock, 1_000);

    void fetch("/api/ultron", { cache: "no-store" })
      .then((response) => setCore(response.ok ? "ONLINE" : "OFFLINE"))
      .catch(() => setCore("OFFLINE"));

    const off = [
      interactionEventBus.on("face.state_changed", ({ payload }) => setFace(payload.state)),
      interactionEventBus.on("camera.state_changed", ({ payload }) => setCamera(payload.state)),
      interactionEventBus.on("gesture.detected", ({ payload }) => {
        setGesture(payload.gesture);
        if (gestureTimer.current !== null) window.clearTimeout(gestureTimer.current);
        gestureTimer.current = window.setTimeout(() => {
          setGesture("standby");
          gestureTimer.current = null;
        }, 650);
      }),
      interactionEventBus.on("voice.listening", ({ payload }) =>
        setVoice(payload.active ? "LISTENING" : "STANDBY"),
      ),
      interactionEventBus.on("voice.transcribing", ({ payload }) =>
        setVoice(payload.active ? "TRANSCRIBING" : "STANDBY"),
      ),
      interactionEventBus.on("voice.speaking", ({ payload }) =>
        setVoice(payload.active ? "SPEAKING" : "STANDBY"),
      ),
      interactionEventBus.on("clap.double_detected", () => setActivation("DOUBLE CLAP")),
      interactionEventBus.on("clap.activation_detected", ({ payload }) =>
        setActivation(payload.clapCount === 1 ? "CLAP" : "DOUBLE CLAP"),
      ),
      interactionEventBus.on("voice.wake_detected", () => setActivation("WAKE WORD")),
    ];

    return () => {
      window.clearInterval(interval);
      if (gestureTimer.current !== null) window.clearTimeout(gestureTimer.current);
      for (const unsubscribe of off) unsubscribe();
    };
  }, []);

  return (
    <>
      <section className="hud-panel system-vitals" aria-label="System vitals">
        <header>SYSTEM VITALS</header>
        <StatusLine label="CORE" value={core} />
        <StatusLine label="FACE" value={face.toUpperCase()} />
        <StatusLine label="VAULT" value="LOCAL" />
      </section>

      <section className="hud-panel schedule-panel" aria-label="Schedule">
        <header>SCHEDULE // {clock}</header>
        <StatusLine label="OUTLOOK" value="NOT CONNECTED" />
        <StatusLine label="COLLEGE" value="MANUAL" />
      </section>

      <section className="hud-panel audio-panel" aria-label="Audio input and output">
        <header>AUDIO I/O</header>
        <StatusLine label="VOICE" value={voice} />
        <StatusLine label="VAD" value="LOCAL // CONFIGURED" />
        <StatusLine label="TTS" value="MICHAEL // CONFIGURED" />
      </section>

      <section className="hud-panel context-panel" aria-label="Current context">
        <header>CURRENT CONTEXT</header>
        <StatusLine label="PROJECT" value="AI-ASSISTANT" />
        <StatusLine label="LOCATION" value="PRIVATE // LOCAL" />
        <StatusLine label="INPUT" value={activation} />
        <StatusLine label="CAMERA" value={camera.toUpperCase()} />
        <StatusLine label="GESTURE" value={gesture.toUpperCase()} />
      </section>
    </>
  );
}
