"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  interactionEventBus,
  type CameraState,
} from "@/interaction/events";
import { cameraReadiness } from "@/interaction/gesture/cameraState";
import { shouldHandleHudShortcut } from "@/interaction/gesture/keyboardControls";
import { bindFaceRenderer } from "@/interaction/face/bindFaceRenderer";
import { faceController } from "@/interaction/face/faceController";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

export default function AssistantOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);

  const [camera, setCamera] = useState<CameraState>("disabled");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);

  const publishCameraState = useCallback(
    (state: CameraState, reason?: string) => {
      setCamera(state);
      interactionEventBus.emit({
        type: "camera.state_changed",
        timestamp: Date.now(),
        payload: { state, ...(reason ? { reason } : {}) },
      });
    },
    [],
  );

  useEffect(() => {
    interactionEventBus.emit({
      type: "camera.state_changed",
      timestamp: Date.now(),
      payload: { state: "disabled" },
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let scene: OrbSceneApi;
    let unbindFace: () => void = () => {};
    try {
      scene = createOrbScene(container);
      sceneRef.current = scene;
      unbindFace = bindFaceRenderer(scene);
      setRendererError(null);
    } catch {
      setRendererError("FACE RENDERER UNAVAILABLE");
      faceController.setState("error");
      return;
    }
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      unbindFace();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setError(null);
    publishCameraState("disabled");
    setStatus({ hands: 0, mode: "idle" });
  }, [publishCameraState]);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    publishCameraState("starting");
    setError(null);

    let tracker: HandTracker;
    tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
      onError: () => {
        if (trackerRef.current !== tracker) return;
        trackerRef.current = null;
        const message = "GESTURE TRACKING FAILED";
        setError(message);
        setStatus({ hands: 0, mode: "idle" });
        publishCameraState("error", message);
      },
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      if (trackerRef.current !== tracker) return;
      publishCameraState("active");
    } catch (err) {
      if (trackerRef.current !== tracker) return;
      trackerRef.current = null;
      tracker.stop();
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED";
      setError(message);
      publishCameraState("error", message);
    }
  }, [publishCameraState]);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shouldHandleHudShortcut(e)) return;
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures]);

  const cameraOn = camera === "active";
  const readiness = cameraReadiness(camera);

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">ULTRON</div>

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS {"\u00b1"} SPREAD</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">G</span> hand gestures&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/{"\u2212"}</span> zoom
          </div>
        )}
      </div>

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `CAMERA ACTIVE · GESTURES READY · ${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
              : "CAMERA ACTIVE · GESTURES READY · SHOW HANDS"}
          </div>
        </div>

        {(rendererError ?? error) && <div className="hud-error">{rendererError ?? error}</div>}

        <div className="hud-row" role="status" aria-live="polite">
          <span>CAMERA {readiness.camera}</span>
          <span>GESTURES {readiness.gestures}</span>
        </div>

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting"
              ? "INITIALIZING..."
              : cameraOn
                ? "GESTURES ON"
                : camera === "error"
                  ? "RETRY GESTURES"
                  : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            {"\u2212"}
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
