"""Adapters that connect local audio components to the one Ultron core."""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Protocol, Sequence

from .interaction import EventName, InteractionEvent
from .local_endpoint import local_base_url
from .write_approval import PendingWriteApproval


class VadAdapter(Protocol):
    def accept(self, samples: Sequence[float], sample_rate: int) -> Sequence[float] | None: ...


class SpeechToTextAdapter(Protocol):
    def transcribe(self, audio_path: Path) -> str: ...


class TextToSpeechAdapter(Protocol):
    def speak(self, text: str) -> None: ...


class UltronCoreAdapter(Protocol):
    def execute(self, message: str) -> str: ...


@dataclass(frozen=True, slots=True)
class CoreExecutionResult:
    spoken: str
    pending_write: PendingWriteApproval | None = None


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

    def execute(self, message: str, *, confirmation_id: str | None = None) -> str:
        return self.execute_detailed(message, confirmation_id=confirmation_id).spoken

    def execute_detailed(
        self,
        message: str,
        *,
        confirmation_id: str | None = None,
    ) -> CoreExecutionResult:
        if not message.strip():
            raise ValueError("message is required")
        body: dict[str, object] = {"message": message, "sessionId": "local", "source": "voice"}
        if confirmation_id:
            body["confirmationId"] = confirmation_id
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(body).encode(),
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
        return self._result_from_payload(payload, original_message=message)

    def execute_stream(self, message: str) -> Iterator[str]:
        """Yield text deltas from the NDJSON voice stream; return the full reply."""

        if not message.strip():
            raise ValueError("message is required")
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps({
                "message": message,
                "sessionId": "local",
                "source": "voice",
                "stream": True,
            }).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/x-ndjson"},
            method="POST",
        )
        pieces: list[str] = []
        final_human: str | None = None
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                while True:
                    line = response.readline()
                    if not line:
                        break
                    text = line.decode("utf-8", errors="replace").strip()
                    if not text:
                        continue
                    try:
                        frame = json.loads(text)
                    except json.JSONDecodeError as error:
                        raise RuntimeError("Ultron core returned an invalid stream frame") from error
                    if not isinstance(frame, dict):
                        raise RuntimeError("Ultron core returned an invalid stream frame")
                    kind = frame.get("type")
                    if kind == "delta":
                        delta = frame.get("text")
                        if isinstance(delta, str) and delta:
                            pieces.append(delta)
                            yield delta
                        continue
                    if kind in {"done", "error"}:
                        final_human = self._human_from_stream_response(frame.get("response"))
                        break
                    raise RuntimeError("Ultron core returned an unknown stream frame")
        except urllib.error.HTTPError as error:
            if error.code != 500:
                raise
            with error:
                payload = json.load(error)
            if not isinstance(payload, dict) or payload.get("status") != "error":
                raise RuntimeError("Ultron core request failed") from None
            raise RuntimeError("Ultron core request failed") from None
        if final_human is None:
            joined = "".join(pieces).strip()
            if not joined:
                raise RuntimeError("Ultron core returned no human response")
            return joined
        return final_human

    @classmethod
    def _result_from_payload(cls, payload: dict[str, object], *, original_message: str) -> CoreExecutionResult:
        if payload.get("status") == "confirmation_required":
            confirmation = payload.get("confirmation")
            pending = cls._pending_write_from_confirmation(confirmation, original_message)
            if pending is not None:
                if pending.risk == "reversible_write":
                    spoken = (
                        "I need your voice approval. Say yes, do it after speaker verification "
                        "to allow this reversible action."
                    )
                else:
                    spoken = (
                        "I need the Windows approval dialog for this consequential action. "
                        "Voice yes cannot approve it."
                    )
                return CoreExecutionResult(spoken, pending)
            return CoreExecutionResult(
                "I need your approval in the Ultron HUD before sharing this context with the cloud."
            )
        if payload.get("status") == "error":
            human = payload.get("human")
            if isinstance(human, str) and human.strip():
                # Speak the safe local error text; do not invent a success reply.
                return CoreExecutionResult(human.strip())
            raise RuntimeError("Ultron core request failed")
        output = payload.get("output")
        if isinstance(output, dict) and output.get("skill") == "dictation":
            return CoreExecutionResult("Your words are written in the Ultron HUD.")
        human = payload.get("human")
        if not isinstance(human, str) or not human.strip():
            raise RuntimeError("Ultron core returned no human response")
        return CoreExecutionResult(human.strip())

    @staticmethod
    def _pending_write_from_confirmation(
        confirmation: object,
        original_message: str,
    ) -> PendingWriteApproval | None:
        if not isinstance(confirmation, dict):
            return None
        risk = confirmation.get("risk")
        if risk not in {"reversible_write", "consequential_write"}:
            return None
        challenge_id = confirmation.get("id")
        scope = confirmation.get("scope")
        description = confirmation.get("description")
        if not isinstance(challenge_id, str) or not challenge_id.strip():
            return None
        if not isinstance(scope, str) or not isinstance(description, str):
            return None
        expires_at = confirmation.get("expiresAt")
        return PendingWriteApproval(
            challenge_id=challenge_id,
            message=original_message,
            risk=risk,
            scope=scope,
            description=description,
            expires_at=expires_at if isinstance(expires_at, str) else None,
        )

    @classmethod
    def _human_from_stream_response(cls, payload: object) -> str:
        if not isinstance(payload, dict):
            raise RuntimeError("Ultron core returned an invalid stream response")
        # Stream error frames keep raising so the pipeline does not play a partial success.
        if payload.get("status") == "error":
            human = payload.get("human")
            if isinstance(human, str) and human.strip():
                raise RuntimeError(human.strip())
            raise RuntimeError("Ultron core request failed")
        return cls._result_from_payload(payload, original_message="").spoken


HUD_SAFE_EVENTS = frozenset(
    {
        EventName.VOICE_WAKE_DETECTED,
        EventName.VOICE_LISTENING,
        EventName.VOICE_AUDIO_LEVEL,
        EventName.VOICE_TRANSCRIBING,
        EventName.VOICE_THINKING,
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
