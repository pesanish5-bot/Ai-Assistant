"""Normalized interaction events, TTS suppression, and lock-state routing."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType
from typing import Mapping, Protocol


JsonScalar = str | int | float | bool | None


class EventName(StrEnum):
    VOICE_WAKE_DETECTED = "voice.wake_detected"
    VOICE_LISTENING = "voice.listening"
    VOICE_TRANSCRIBING = "voice.transcribing"
    VOICE_SPEAKING = "voice.speaking"
    CLAP_DOUBLE_DETECTED = "clap.double_detected"
    CLAP_ACTIVATION_DETECTED = "clap.activation_detected"
    HUD_OPEN_REQUESTED = "hud.open_requested"
    AUTH_START_REQUESTED = "auth.start_requested"
    AUTH_STARTED = "auth.started"
    AUTH_IDENTITY_VERIFIED = "auth.identity_verified"
    AUTH_CHALLENGE_ISSUED = "auth.challenge_issued"
    AUTH_PROTOTYPE_VERIFIED = "auth.prototype_verified"
    AUTH_FAILED = "auth.failed"
    AUTH_THROTTLED = "auth.throttled"
    ACTIVATION_REJECTED = "activation.rejected"


@dataclass(frozen=True, slots=True)
class InteractionEvent:
    """A small event suitable for local IPC or UI state projection."""

    name: EventName
    timestamp: float
    source: str
    payload: Mapping[str, JsonScalar] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.timestamp < 0:
            raise ValueError("timestamp must be non-negative")
        if not self.source.strip():
            raise ValueError("source is required")
        object.__setattr__(self, "payload", MappingProxyType(dict(self.payload)))

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name.value,
            "timestamp": self.timestamp,
            "source": self.source,
            "payload": dict(self.payload),
        }


class SessionState(StrEnum):
    UNLOCKED = "unlocked"
    LOCKED = "locked"
    UNKNOWN = "unknown"


class LockStateProvider(Protocol):
    """Implemented later by a native WTS session-notification adapter."""

    def current_state(self) -> SessionState: ...


@dataclass(slots=True)
class TtsPlaybackGate:
    """Suppress microphone activators while Ultron is producing speaker audio."""

    post_playback_ms: int = 500
    _active: bool = field(default=False, init=False)
    _suppress_until: float = field(default=0.0, init=False)

    def __post_init__(self) -> None:
        if self.post_playback_ms < 0:
            raise ValueError("post_playback_ms cannot be negative")

    def playback_started(self, timestamp: float) -> InteractionEvent:
        self._validate_time(timestamp)
        self._active = True
        self._suppress_until = float("inf")
        return InteractionEvent(EventName.VOICE_SPEAKING, timestamp, "tts", {"active": True})

    def playback_finished(self, timestamp: float) -> InteractionEvent:
        self._validate_time(timestamp)
        self._active = False
        self._suppress_until = timestamp + self.post_playback_ms / 1000.0
        return InteractionEvent(EventName.VOICE_SPEAKING, timestamp, "tts", {"active": False})

    def is_suppressed(self, timestamp: float) -> bool:
        self._validate_time(timestamp)
        return self._active or timestamp < self._suppress_until

    @staticmethod
    def _validate_time(timestamp: float) -> None:
        if timestamp < 0:
            raise ValueError("timestamp must be non-negative")


@dataclass(slots=True)
class LockStateRouter:
    """Route a double clap without inferring lock state from visible windows."""

    listen_after_open: bool = True

    def route(self, event: InteractionEvent, session_state: SessionState) -> InteractionEvent:
        if event.name not in {
            EventName.CLAP_ACTIVATION_DETECTED,
            EventName.CLAP_DOUBLE_DETECTED,
        }:
            raise ValueError("LockStateRouter only accepts clap activation events")

        if session_state is SessionState.UNLOCKED:
            return InteractionEvent(
                EventName.HUD_OPEN_REQUESTED,
                event.timestamp,
                "lock-state-router",
                {"enter_listening": self.listen_after_open},
            )
        if session_state is SessionState.LOCKED:
            return InteractionEvent(
                EventName.AUTH_START_REQUESTED,
                event.timestamp,
                "lock-state-router",
                {"prototype_only": True, "os_unlock": False},
            )
        return InteractionEvent(
            EventName.ACTIVATION_REJECTED,
            event.timestamp,
            "lock-state-router",
            {"reason": "lock_state_unknown"},
        )
