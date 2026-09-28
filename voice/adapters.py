"""Adapters that connect local audio components to the one Ultron core."""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.error
import urllib.request
from pathlib import Path
from typing import Protocol, Sequence

from .interaction import EventName, InteractionEvent
from .local_endpoint import local_base_url


class VadAdapter(Protocol):
    def accept(self, samples: Sequence[float], sample_rate: int) -> Sequence[float] | None: ...


class SpeechToTextAdapter(Protocol):
    def transcribe(self, audio_path: Path) -> str: ...


class TextToSpeechAdapter(Protocol):
    def speak(self, text: str) -> None: ...


class UltronCoreAdapter(Protocol):
    def execute(self, message: str) -> str: ...


class LocalUltronHttpAdapter:
    """Send normal transcribed conversation to the existing `/api/ultron`.

    Authentication audio, biometrics, scores, and challenges must never use
    this adapter. Only loopback endpoints are accepted.
    """

    def __init__(self, endpoint: str | None = None, timeout: float = 90.0) -> None:
        endpoint = endpoint if endpoint is not None else local_base_url() + "/api/ultron"
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Ultron core endpoint must be loopback HTTP")
        if parsed.path != "/api/ultron":
            raise ValueError("Ultron core endpoint path must be /api/ultron")
        self.endpoint = endpoint
        self.timeout = timeout

    def execute(self, message: str) -> str:
        if not message.strip():
            raise ValueError("message is required")
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps({"message": message, "sessionId": "local", "source": "voice"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code != 500:
                raise
            with error:
                payload = json.load(error)
            if not isinstance(payload, dict) or payload.get("status") != "error":
                raise RuntimeError("Ultron core request failed") from None
        if not isinstance(payload, dict):
            raise RuntimeError("Ultron core returned an invalid response")
        if payload.get("status") == "confirmation_required":
            return "I need your approval in the Ultron HUD before sharing this context with the cloud."
        output = payload.get("output")
        if isinstance(output, dict) and output.get("skill") == "dictation":
            return "Your words are written in the Ultron HUD."
        human = payload.get("human")
        if not isinstance(human, str) or not human.strip():
            raise RuntimeError("Ultron core returned no human response")
        return human


HUD_SAFE_EVENTS = frozenset(
    {
        EventName.VOICE_WAKE_DETECTED,
        EventName.VOICE_LISTENING,
        EventName.VOICE_TRANSCRIBING,
        EventName.VOICE_SPEAKING,
        EventName.CLAP_DOUBLE_DETECTED,
        EventName.CLAP_ACTIVATION_DETECTED,
        EventName.HUD_OPEN_REQUESTED,
        EventName.AUTH_STARTED,
        EventName.AUTH_PROTOTYPE_VERIFIED,
        EventName.AUTH_FAILED,
        EventName.ACTIVATION_REJECTED,
    }
)


def is_hud_safe_event(event: InteractionEvent) -> bool:
    return event.name in HUD_SAFE_EVENTS


class LocalHudEventAdapter:
    """Project only coarse, non-biometric interaction state into the HUD."""

    def __init__(
        self,
        endpoint: str | None = None,
        token: str | None = None,
        timeout: float = 2.0,
    ) -> None:
        endpoint = endpoint if endpoint is not None else local_base_url() + "/api/interaction"
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Ultron HUD endpoint must be loopback HTTP")
        if parsed.path != "/api/interaction":
            raise ValueError("Ultron HUD endpoint path must be /api/interaction")
        resolved_token = token or os.environ.get("ULTRON_LOCAL_EVENT_TOKEN")
        if not resolved_token or len(resolved_token) < 32:
            raise ValueError("ULTRON_LOCAL_EVENT_TOKEN must contain at least 32 characters")
        self.endpoint = endpoint
        self.token = resolved_token
        self.timeout = timeout

    def publish(self, event: InteractionEvent) -> None:
        if not is_hud_safe_event(event):
            raise ValueError(f"event is not permitted on the HUD bridge: {event.name.value}")
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(event.to_dict(), separators=(",", ":")).encode(),
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            if response.status >= 300:
                raise RuntimeError(f"Ultron HUD bridge returned HTTP {response.status}")
