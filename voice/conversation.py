"""One-turn local conversational voice pipeline for the existing Ultron core.

This module intentionally has no authentication entry point. It accepts one
ordinary conversational utterance, sends only its parsed text to the existing
loopback Ultron HTTP API, and speaks the returned human response locally.
"""

from __future__ import annotations

import re
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Callable, Iterator, Protocol

from .adapters import (
    LocalHudEventAdapter,
    LocalUltronHttpAdapter,
    SpeechToTextAdapter,
    TextToSpeechAdapter,
    UltronCoreAdapter,
)
from .interaction import EventName, InteractionEvent, TtsPlaybackGate
from .windows_activation import MicrophoneUnavailableError
from .windows_activation import ListeningPipelineError


class EventSink(Protocol):
    """Structural event sink implemented by ``LocalHudEventAdapter``."""

    def publish(self, event: InteractionEvent) -> None: ...


class UtteranceCapture(Protocol):
    """Capture one locally endpointed utterance into ``destination``."""

    def capture(self, destination: Path) -> None: ...


class ConversationMode(StrEnum):
    """Conversational activation modes; authentication is deliberately absent."""

    DIRECT = "direct"
    WAKE_WORD = "wake_word"
    DOUBLE_CLAP = "double_clap"


class VoicePipelineStage(StrEnum):
    EVENTS = "events"
    CAPTURE = "capture"
    TRANSCRIPTION = "transcription"
    CORE = "core"
    TTS = "tts"


class VoicePipelineError(ListeningPipelineError):
    """A non-microphone failure with an explicit pipeline stage."""

    def __init__(self, stage: VoicePipelineStage, message: str) -> None:
        super().__init__(message)
        self.stage = stage


class VoiceMicrophoneError(MicrophoneUnavailableError):
    """Microphone open/read/endpoint failure, distinct from model/core errors."""


class UtteranceTimeoutError(VoiceMicrophoneError):
    """No completed speech segment arrived before the local capture timeout."""


@dataclass(frozen=True, slots=True)
class VoiceTurnResult:
    mode: ConversationMode
    transcript: str
    command: str | None
    response: str | None
    accepted: bool


@dataclass(frozen=True, slots=True)
class WakeWordParser:
    """Recognize a leading wake word without requiring it in clap/direct mode."""

    wake_word: str = "Ultron"

    def __post_init__(self) -> None:
        if not self.wake_word.strip():
            raise ValueError("wake_word is required")

    def parse(self, transcript: str, *, required: bool) -> str | None:
        text = transcript.strip()
        if not text:
            return None
        match = re.match(
            rf"^\s*{re.escape(self.wake_word)}(?:\s*[,.:;!?-]\s*|\s+|$)(.*)$",
            text,
            flags=re.IGNORECASE,
        )
        if match:
            command = match.group(1).strip()
            return command or None
        return None if required else text

    def detected(self, transcript: str) -> bool:
        return bool(
            re.match(
                rf"^\s*{re.escape(self.wake_word)}(?:\s*[,.:;!?-]\s*|\s+|$)",
                transcript.strip(),
                flags=re.IGNORECASE,
            )
        )


class LocalConversationalVoicePipeline:
    """Capture, transcribe, execute, and speak exactly one normal voice turn."""

    def __init__(
        self,
        *,
        capture: UtteranceCapture,
        stt: SpeechToTextAdapter,
        core: UltronCoreAdapter,
        tts: TextToSpeechAdapter,
        events: EventSink,
        tts_gate: TtsPlaybackGate,
        wake_word: WakeWordParser | None = None,
        conversation_allowed: Callable[[], bool] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.capture = capture
        self.stt = stt
        self.core = core
        self.tts = tts
        self.events = events
        self.tts_gate = tts_gate
        self.wake_word = wake_word or WakeWordParser()
        self.conversation_allowed = conversation_allowed
        self.clock = clock
        self._turn_lock = threading.Lock()

    def run_once(self, mode: ConversationMode = ConversationMode.DIRECT) -> VoiceTurnResult:
        """Run one turn; the temporary WAV is removed before the core is called."""

        if not self._turn_lock.acquire(blocking=False):
            raise VoicePipelineError(VoicePipelineStage.CAPTURE, "a voice turn is already active")
        try:
            self._require_conversation_allowed()
            transcript = self._capture_and_transcribe()
            command = self.wake_word.parse(
                transcript,
                required=mode is ConversationMode.WAKE_WORD,
            )
            if command is None:
                return VoiceTurnResult(mode, transcript, None, None, False)

            # Revalidate after the potentially long capture/transcription and
            # immediately before normal text can leave for the existing core.
            self._require_conversation_allowed()
            try:
                response = self.core.execute(command)
            except Exception as error:
                raise VoicePipelineError(
                    VoicePipelineStage.CORE,
                    "Ultron core could not process the transcribed conversation",
                ) from error
            if not isinstance(response, str) or not response.strip():
                raise VoicePipelineError(
                    VoicePipelineStage.CORE,
                    "Ultron core returned an empty conversational response",
                )
            response = response.strip()

            self._require_conversation_allowed()
            with self._tts_state():
                try:
                    self.tts.speak(response)
                except Exception as error:
                    raise VoicePipelineError(
                        VoicePipelineStage.TTS,
                        "local Kokoro playback failed",
                    ) from error
            return VoiceTurnResult(mode, transcript, command, response, True)
        finally:
            self._turn_lock.release()

    def _require_conversation_allowed(self) -> None:
        if self.conversation_allowed is None:
            return
        try:
            allowed = self.conversation_allowed()
        except Exception as error:
            raise VoicePipelineError(
                VoicePipelineStage.CAPTURE,
                "Windows session authorization could not be verified",
            ) from error
        if not allowed:
            raise VoicePipelineError(
                VoicePipelineStage.CAPTURE,
                "Windows session is no longer available for conversation",
            )

    def _capture_and_transcribe(self) -> str:
        with tempfile.TemporaryDirectory(prefix="ultron-conversation-") as temporary:
            audio_path = Path(temporary) / "utterance.wav"
            with self._state(EventName.VOICE_LISTENING, "microphone"):
                try:
                    self.capture.capture(audio_path)
                except VoiceMicrophoneError:
                    raise
                except VoicePipelineError:
                    raise
                except Exception as error:
                    raise VoiceMicrophoneError("microphone capture failed") from error

            with self._state(EventName.VOICE_TRANSCRIBING, "stt"):
                try:
                    transcript = self.stt.transcribe(audio_path)
                except Exception as error:
                    raise VoicePipelineError(
                        VoicePipelineStage.TRANSCRIPTION,
                        "local faster-whisper transcription failed",
                    ) from error

        if not isinstance(transcript, str):
            raise VoicePipelineError(
                VoicePipelineStage.TRANSCRIPTION,
                "local faster-whisper returned an invalid transcript",
            )
        return transcript.strip()

    @contextmanager
    def _state(self, name: EventName, source: str) -> Iterator[None]:
        self._publish(InteractionEvent(name, self.clock(), source, {"active": True}))
        try:
            yield
        except BaseException:
            try:
                self._publish(InteractionEvent(name, self.clock(), source, {"active": False}))
            except VoicePipelineError:
                pass
            raise
        else:
            self._publish(InteractionEvent(name, self.clock(), source, {"active": False}))

    @contextmanager
    def _tts_state(self) -> Iterator[None]:
        started = self.tts_gate.playback_started(self.clock())
        try:
            self._publish(started)
        except BaseException:
            self.tts_gate.playback_finished(self.clock())
            raise
        try:
            yield
        except BaseException:
            finished = self.tts_gate.playback_finished(self.clock())
            try:
                self._publish(finished)
            except VoicePipelineError:
                pass
            raise
        else:
            self._publish(self.tts_gate.playback_finished(self.clock()))

    def _publish(self, event: InteractionEvent) -> None:
        try:
            self.events.publish(event)
        except Exception as error:
            raise VoicePipelineError(
                VoicePipelineStage.EVENTS,
                "local HUD interaction event could not be published",
            ) from error


def build_local_conversation_pipeline(
    *,
    event_sink: EventSink | None = None,
    core: UltronCoreAdapter | None = None,
    tts_gate: TtsPlaybackGate | None = None,
    hud_token: str | None = None,
    microphone_device: int | None = None,
    output_device: int | None = None,
    model_root: Path | None = None,
    stt: SpeechToTextAdapter | None = None,
    conversation_allowed: Callable[[], bool] | None = None,
) -> LocalConversationalVoicePipeline:
    """Build the production-local adapters without loading hardware/models yet."""

    from .local_conversation_audio import (
        FasterWhisperSmallAdapter,
        KokoroMichaelAdapter,
        SileroVadMicrophoneCapture,
        default_voice_model_root,
    )
    root = (model_root or default_voice_model_root()).expanduser().resolve()
    return LocalConversationalVoicePipeline(
        capture=SileroVadMicrophoneCapture(
            model_path=root / "sherpa-onnx" / "silero_vad.onnx",
            device=microphone_device,
            capture_allowed=conversation_allowed,
        ),
        stt=stt or FasterWhisperSmallAdapter(model_root=root),
        core=core or LocalUltronHttpAdapter(),
        tts=KokoroMichaelAdapter(
            model_directory=root / "sherpa-onnx" / "kokoro-en-v0_19",
            device=output_device,
            playback_allowed=conversation_allowed,
        ),
        events=event_sink or LocalHudEventAdapter(token=hud_token),
        tts_gate=tts_gate or TtsPlaybackGate(),
        conversation_allowed=conversation_allowed,
    )


@dataclass(slots=True)
class DoubleClapListeningSession:
    """Adapt the synchronous one-turn pipeline to the Windows activation seam."""

    pipeline: LocalConversationalVoicePipeline

    def start(self, timestamp: float) -> InteractionEvent | None:
        del timestamp
        self.pipeline.run_once(ConversationMode.DOUBLE_CLAP)
        return None
