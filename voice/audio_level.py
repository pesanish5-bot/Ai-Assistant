"""Bounded, nonblocking visual meter for active conversational microphone capture."""

from __future__ import annotations

import threading
import time
from typing import Callable, Protocol

from .interaction import EventName, InteractionEvent


class EventSink(Protocol):
    def publish(self, event: InteractionEvent) -> None: ...


class AudioLevelPublisher:
    def __init__(
        self,
        sink: EventSink,
        *,
        interval_seconds: float = 0.15,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if interval_seconds <= 0:
            raise ValueError("audio-level interval must be positive")
        self.sink = sink
        self.interval_seconds = interval_seconds
        self.clock = clock
        self._lock = threading.Lock()
        self._last_sent = float("-inf")
        self._busy = False

    def publish_level(self, level: float) -> None:
        if not 0 <= level <= 1:
            return
        now = self.clock()
        with self._lock:
            if self._busy or now - self._last_sent < self.interval_seconds:
                return
            self._busy = True
            self._last_sent = now
        threading.Thread(
            target=self._send,
            args=(round(level, 2),),
            name="UltronAudioLevel",
            daemon=True,
        ).start()

    def _send(self, level: float) -> None:
        try:
            self.sink.publish(InteractionEvent(
                EventName.VOICE_AUDIO_LEVEL,
                time.time(),
                "microphone-meter",
                {"level": level},
            ))
        except Exception:
            # HUD connectivity must never affect microphone capture.
            pass
        finally:
            with self._lock:
                self._busy = False
