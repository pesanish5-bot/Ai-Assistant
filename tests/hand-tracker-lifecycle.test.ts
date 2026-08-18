import assert from "node:assert/strict";
import test from "node:test";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { HandTracker } from "../lib/handTracker.ts";

type EndedListener = () => void;

function fakeTrack() {
  let ended: EndedListener | undefined;
  let stops = 0;
  return {
    track: {
      addEventListener(type: string, listener: EndedListener) {
        if (type === "ended") ended = listener;
      },
      removeEventListener(type: string, listener: EndedListener) {
        if (type === "ended" && ended === listener) ended = undefined;
      },
      stop() {
        stops += 1;
      },
    } as unknown as MediaStreamTrack,
    end: () => ended?.(),
    stops: () => stops,
  };
}

function fakeStream(track: MediaStreamTrack): MediaStream {
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

function fakeElements() {
  const video = {
    srcObject: null,
    readyState: 2,
    currentTime: 1,
    async play() {},
  } as unknown as HTMLVideoElement;
  const context = {
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    arc() {},
    fill() {},
  };
  const overlay = {
    width: 208,
    height: 156,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { video, overlay };
}

async function withBrowserMocks(
  getUserMedia: () => Promise<MediaStream>,
  operation: () => Promise<void>,
) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const cancelDescriptor = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalResolve = FilesetResolver.forVisionTasks;
  const originalCreate = HandLandmarker.createFromOptions;
  let nextFrame = 0;
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia } },
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: () => ++nextFrame,
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: () => {},
    });
    await operation();
  } finally {
    FilesetResolver.forVisionTasks = originalResolve;
    HandLandmarker.createFromOptions = originalCreate;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete (globalThis as { navigator?: Navigator }).navigator;
    if (requestDescriptor) Object.defineProperty(globalThis, "requestAnimationFrame", requestDescriptor);
    else delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
    if (cancelDescriptor) Object.defineProperty(globalThis, "cancelAnimationFrame", cancelDescriptor);
    else delete (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame;
  }
}

function callbacks(errors: unknown[]) {
  return {
    onRotate() {},
    onZoom() {},
    onStatus() {},
    onError(error: unknown) {
      errors.push(error);
    },
  };
}

test("camera permission failure rejects without claiming runtime activation", async () => {
  const denied = new DOMException("denied", "NotAllowedError");
  await withBrowserMocks(
    async () => {
      throw denied;
    },
    async () => {
      const { video, overlay } = fakeElements();
      const errors: unknown[] = [];
      const tracker = new HandTracker(video, overlay, callbacks(errors));
      await assert.rejects(tracker.start(), (error) => error === denied);
      assert.deepEqual(errors, []);
    },
  );
});

test("stopping during camera permission startup disposes the late stream", async () => {
  const controlled = Promise.withResolvers<MediaStream>();
  const tracked = fakeTrack();
  await withBrowserMocks(
    () => controlled.promise,
    async () => {
      const { video, overlay } = fakeElements();
      const tracker = new HandTracker(video, overlay, callbacks([]));
      const starting = tracker.start();
      tracker.stop();
      controlled.resolve(fakeStream(tracked.track));
      await starting;
      assert.equal(tracked.stops(), 1);
      assert.equal(video.srcObject, null);
    },
  );
});

test("a detector exception stops the camera and reports one runtime failure", async () => {
  const tracked = fakeTrack();
  await withBrowserMocks(
    async () => fakeStream(tracked.track),
    async () => {
      FilesetResolver.forVisionTasks = async () => ({}) as never;
      HandLandmarker.createFromOptions = async () =>
        ({
          close() {},
          detectForVideo() {
            throw new Error("detector failed");
          },
        }) as never;
      const { video, overlay } = fakeElements();
      const errors: unknown[] = [];
      const tracker = new HandTracker(video, overlay, callbacks(errors));
      await tracker.start();
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]), /detector failed/);
      assert.equal(tracked.stops(), 1);
      assert.equal(video.srcObject, null);
    },
  );
});

test("an ended camera track shuts down tracking exactly once", async () => {
  const tracked = fakeTrack();
  let closes = 0;
  await withBrowserMocks(
    async () => fakeStream(tracked.track),
    async () => {
      FilesetResolver.forVisionTasks = async () => ({}) as never;
      HandLandmarker.createFromOptions = async () =>
        ({
          close() {
            closes += 1;
          },
          detectForVideo() {
            return { landmarks: [], handedness: [] };
          },
        }) as never;
      const { video, overlay } = fakeElements();
      const errors: unknown[] = [];
      const tracker = new HandTracker(video, overlay, callbacks(errors));
      await tracker.start();
      tracked.end();
      tracked.end();
      assert.equal(errors.length, 1);
      assert.equal(tracked.stops(), 1);
      assert.equal(closes, 1);
      assert.equal(video.srcObject, null);
    },
  );
});
