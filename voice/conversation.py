"""One-turn local conversational voice pipeline for the existing Ultron core.

This module intentionally has no authentication entry point. It accepts one
ordinary conversational utterance, sends only its parsed text to the existing
loopback Ultron HTTP API, and speaks the returned human response locally.
"""

from __future__ import annotations

import os
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
from .speech_text import for_speech, iter_speakable_units
from .windows_activation import MicrophoneUnavailableError
from .windows_activation import ListeningPipelineError
from .write_approval import (
    LocalWriteConfirmAdapter,
    PendingWriteApproval,
    is_voice_write_approval,
)


class EventSink(Protocol):
    """Structural event sink implemented by ``LocalHudEventAdapter``."""

    def publish(self, event: InteractionEvent) -> None: ...


class UtteranceCapture(Protocol):
    """Capture one locally endpointed utterance into ``destination``."""

    def capture(self, destination: Path, *, timeout_seconds: float | None = None) -> None: ...


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
            if command and re.fullmatch(
                rf"{re.escape(self.wake_word)}(?:[\s,.:;!?-]+{re.escape(self.wake_word)})*",
                command,
                flags=re.IGNORECASE,
            ):
                return None  # Repeated wake words are not a user command.
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
        timing_reporter: Callable[[str, int], None] | None = None,
        write_confirm: LocalWriteConfirmAdapter | None = None,
        speaker_verified: Callable[[], bool] | None = None,
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
        self.timing_reporter = timing_reporter
        self.write_confirm = write_confirm
        self.speaker_verified = speaker_verified or (lambda: os.environ.get("ULTRON_SPEAKER_SESSION_VERIFIED", "").strip().lower() in {"1", "true", "yes"})
        self._pending_write: PendingWriteApproval | None = None
        self._turn_lock = threading.Lock()

    def run_once(
        self,
        mode: ConversationMode = ConversationMode.DIRECT,
        *,
        capture_timeout_seconds: float | None = None,
    ) -> VoiceTurnResult:
        """Run one turn; the temporary WAV is removed before the core is called."""

        if not self._turn_lock.acquire(blocking=False):
            raise VoicePipelineError(VoicePipelineStage.CAPTURE, "a voice turn is already active")
        try:
            self._require_conversation_allowed()
            transcript = self._capture_and_transcribe(capture_timeout_seconds)
            return self._execute_transcript(mode, transcript)
        finally:
            self._turn_lock.release()

    def run_preheard(self, transcript: str) -> VoiceTurnResult:
        """Use speech already recognized with the wake word, without recording it twice."""

        if not self._turn_lock.acquire(blocking=False):
            raise VoicePipelineError(VoicePipelineStage.CAPTURE, "a voice turn is already active")
        try:
            self._require_conversation_allowed()
            return self._execute_transcript(ConversationMode.WAKE_WORD, transcript)
        finally:
            self._turn_lock.release()

    def _execute_transcript(self, mode: ConversationMode, transcript: str) -> VoiceTurnResult:
        command = self.wake_word.parse(
            transcript,
            required=mode is ConversationMode.WAKE_WORD,
        )
        if command is None:
            if not transcript:
                with self._tts_state():
                    self.tts.speak("I couldn't hear that clearly. Please try again.")
            return VoiceTurnResult(mode, transcript, None, None, False)

        # Revalidate immediately before ordinary text reaches the shared core.
        self._require_conversation_allowed()
        if self._pending_write is not None and is_voice_write_approval(command):
            response = self._resolve_pending_write_approval(command)
            return VoiceTurnResult(mode, transcript, command, response, True)
        if hasattr(self.core, "execute_stream") and self._pending_write is None:
            response = self._speak_streamed_reply(command)
        else:
            response = self._speak_blocking_reply(command)
        return VoiceTurnResult(mode, transcript, command, response, True)

    def _resolve_pending_write_approval(self, command: str) -> str:
        pending = self._pending_write
        if pending is None:
            raise VoicePipelineError(VoicePipelineStage.CORE, "no pending write approval")
        if pending.risk != "reversible_write":
            with self._tts_state():
                spoken = "Voice approval cannot authorize consequential writes. Use the Windows dialog."
                self.tts.speak(spoken)
            return spoken
        if not self.speaker_verified():
            with self._tts_state():
                spoken = "Speaker verification is required before I can approve that write."
                self.tts.speak(spoken)
            return spoken
        confirm = self.write_confirm
        if confirm is None:
            try:
                confirm = LocalWriteConfirmAdapter()
            except Exception as error:
                raise VoicePipelineError(
                    VoicePipelineStage.CORE,
                    "trusted write confirmation channel is unavailable",
                ) from error
        try:
            confirm.approve(pending.challenge_id, speaker_verified=True)
        except Exception as error:
            self._pending_write = None
            raise VoicePipelineError(
                VoicePipelineStage.CORE,
                "trusted write confirmation was rejected",
            ) from error
        original = pending.message
        challenge_id = pending.challenge_id
        self._pending_write = None
        return self._speak_blocking_reply(original, confirmation_id=challenge_id)

    def _speak_blocking_reply(self, command: str, *, confirmation_id: str | None = None) -> str:
        core_started = time.perf_counter()
        with self._state(EventName.VOICE_THINKING, "core"):
            try:
                detailed = getattr(self.core, "execute_detailed", None)
                if callable(detailed):
                    result = detailed(command, confirmation_id=confirmation_id)
                    response = result.spoken
                    self._pending_write = result.pending_write
                elif confirmation_id:
                    raise VoicePipelineError(
                        VoicePipelineStage.CORE,
                        "core adapter cannot submit write confirmations",
                    )
                else:
                    response = self.core.execute(command)
                    self._pending_write = None
            except VoicePipelineError:
                raise
            except Exception as error:
                raise VoicePipelineError(
                    VoicePipelineStage.CORE,
                    "Ultron core could not process the transcribed conversation",
                ) from error
            finally:
                self._report_timing("core", core_started)
        if not isinstance(response, str) or not response.strip():
            raise VoicePipelineError(
                VoicePipelineStage.CORE,
                "Ultron core returned an empty conversational response",
            )
        response = response.strip()
        self._require_conversation_allowed()
        speech_started = time.perf_counter()
        with self._tts_state():
            try:
                self.tts.speak(for_speech(response))
            except Exception as error:
                raise VoicePipelineError(
                    VoicePipelineStage.TTS,
                    "local Kokoro playback failed",
                ) from error
            finally:
                self._report_timing("tts_and_playback", speech_started)
        return response

    def _speak_streamed_reply(self, command: str) -> str:
        """Speak sentence units as model deltas arrive so first audio is not gated on full text."""

        core_started = time.perf_counter()
        final_holder: list[str] = []

        def produce() -> Iterator[str]:
            reported = False
            try:
                stream = self.core.execute_stream(command)  # type: ignore[attr-defined]
                while True:
                    try:
                        delta = next(stream)
                    except StopIteration as done:
                        if isinstance(done.value, str) and done.value.strip():
                            final_holder.append(done.value.strip())
                        return
                    if not reported:
                        reported = True
                        self._report_timing("core_first_delta", core_started)
                    yield delta
            except VoicePipelineError:
                raise
            except Exception as error:
                raise VoicePipelineError(
                    VoicePipelineStage.CORE,
                    "Ultron core could not process the transcribed conversation",
                ) from error

        with self._state(EventName.VOICE_THINKING, "core"):
            units = iter_speakable_units(produce())
            try:
                first = next(units)
            except StopIteration:
                first = None
        self._report_timing("core", core_started)

        spoken: list[str] = []
        self._require_conversation_allowed()
        speech_started = time.perf_counter()
        with self._tts_state():
            try:
                if first is None:
                    response = final_holder[0] if final_holder else ""
                    if not response:
                        raise VoicePipelineError(
                            VoicePipelineStage.CORE,
                            "Ultron core returned an empty conversational response",
                        )
                    self.tts.speak(for_speech(response))
                    return response
                self.tts.speak(for_speech(first))
                spoken.append(first)
                for unit in units:
                    self._require_conversation_allowed()
                    self.tts.speak(for_speech(unit))
                    spoken.append(unit)
            except VoicePipelineError:
                raise
            except Exception as error:
                raise VoicePipelineError(
                    VoicePipelineStage.TTS,
                    "local Kokoro playback failed",
                ) from error
            finally:
                self._report_timing("tts_and_playback", speech_started)

        response = (final_holder[0] if final_holder else " ".join(spoken)).strip()
        if not response:
            raise VoicePipelineError(
                VoicePipelineStage.CORE,
                "Ultron core returned an empty conversational response",
            )
        return response

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

    def _capture_and_transcribe(self, timeout_seconds: float | None = None) -> str:
        with tempfile.TemporaryDirectory(prefix="ultron-conversation-") as temporary:
            audio_path = Path(temporary) / "utterance.wav"
            with self._state(EventName.VOICE_LISTENING, "microphone"):
                capture_started = time.perf_counter()
                try:
                    if timeout_seconds is None:
                        self.capture.capture(audio_path)
                    else:
                        self.capture.capture(audio_path, timeout_seconds=timeout_seconds)
                except UtteranceTimeoutError:
                    raise
                except VoiceMicrophoneError as error:
                    self._signal_microphone_unavailable()
                    raise error
                except VoicePipelineError:
                    raise
                except Exception as error:
                    self._signal_microphone_unavailable()
                    raise VoiceMicrophoneError("microphone capture failed") from error
                finally:
                    self._report_timing("capture", capture_started)

            with self._state(EventName.VOICE_TRANSCRIBING, "stt"):
                transcription_started = time.perf_counter()
                try:
                    transcript = self.stt.transcribe(audio_path)
                except Exception as error:
                    raise VoicePipelineError(
                        VoicePipelineStage.TRANSCRIPTION,
                        "local faster-whisper transcription failed",
                    ) from error
                finally:
                    self._report_timing("transcription", transcription_started)

        if not isinstance(transcript, str):
            raise VoicePipelineError(
                VoicePipelineStage.TRANSCRIPTION,
                "local faster-whisper returned an invalid transcript",
            )
        return transcript.strip()

    def _signal_microphone_unavailable(self) -> None:
        try:
            self._publish(InteractionEvent(
                EventName.ACTIVATION_REJECTED,
                self.clock(),
                "microphone",
                {"reason": "microphone_unavailable"},
            ))
        except VoicePipelineError:
            pass

    def _report_timing(self, stage: str, started: float) -> None:
        if self.timing_reporter is None:
            return
        try:
            self.timing_reporter(stage, round((time.perf_counter() - started) * 1000))
        except Exception:
            pass

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
    timing_reporter: Callable[[str, int], None] | None = None,
) -> LocalConversationalVoicePipeline:
    """Build the production-local adapters without loading hardware/models yet."""

    from .local_conversation_audio import (
        FasterWhisperSmallAdapter,
        KokoroMichaelAdapter,
        SileroVadMicrophoneCapture,
        default_voice_model_root,
    )
    from .audio_level import AudioLevelPublisher
    root = (model_root or default_voice_model_root()).expanduser().resolve()
    events = event_sink or LocalHudEventAdapter(token=hud_token)
    level_publisher = AudioLevelPublisher(events)
    try:
        vad_threshold = float(os.environ.get("ULTRON_VOICE_VAD_THRESHOLD", "0.45"))
        end_silence_ms = int(os.environ.get("ULTRON_VOICE_END_SILENCE_MS", "1100"))
    except ValueError as error:
        raise ValueError("voice VAD configuration is invalid") from error
    if not 0.2 <= vad_threshold <= 0.9 or not 500 <= end_silence_ms <= 2000:
        raise ValueError("voice VAD threshold/silence is outside supported range")
    try:
        tts_gain = float(os.environ.get("ULTRON_VOICE_TTS_GAIN", "1.8"))
    except ValueError as error:
        raise ValueError("voice TTS gain is invalid") from error
    return LocalConversationalVoicePipeline(
        capture=SileroVadMicrophoneCapture(
            model_path=root / "sherpa-onnx" / "silero_vad.onnx",
            device=microphone_device,
            threshold=vad_threshold,
            silence_seconds=end_silence_ms / 1000,
            capture_allowed=conversation_allowed,
            on_audio_level=level_publisher.publish_level,
        ),
        stt=stt or FasterWhisperSmallAdapter(model_root=root),
        core=core or LocalUltronHttpAdapter(),
        tts=KokoroMichaelAdapter(
            model_directory=root / "sherpa-onnx" / "kokoro-en-v0_19",
            device=output_device,
            gain=tts_gain,
            playback_allowed=conversation_allowed,
            timing_reporter=timing_reporter,
        ),
        events=events,
        tts_gate=tts_gate or TtsPlaybackGate(),
        conversation_allowed=conversation_allowed,
        timing_reporter=timing_reporter,
    )


@dataclass(slots=True)
class DoubleClapListeningSession:
    """Keep a short, visible follow-up window after an activated voice turn."""

    pipeline: LocalConversationalVoicePipeline
    max_follow_ups: int = 3
    follow_up_timeout_seconds: float = 8.0
    sleeper: Callable[[float], None] = time.sleep
    pending_wake_transcript: Callable[[float], str | None] | None = None

    def __post_init__(self) -> None:
        if self.max_follow_ups < 0 or self.follow_up_timeout_seconds <= 0:
            raise ValueError("follow-up limits must be positive")

    def start(self, timestamp: float) -> InteractionEvent | None:
        preheard = self.pending_wake_transcript(timestamp) if self.pending_wake_transcript else None
        first = (
            self.pipeline.run_preheard(preheard)
            if preheard else self.pipeline.run_once(ConversationMode.DOUBLE_CLAP)
        )
        if not first.accepted:
            return None
        for _ in range(self.max_follow_ups):
            # Bluetooth speakers can trail after playback has returned. Wait for
            # the same suppression interval used by wake/clap detection.
            self.sleeper(self.pipeline.tts_gate.post_playback_ms / 1000.0)
            try:
                follow_up = self.pipeline.run_once(
                    ConversationMode.DIRECT,
                    capture_timeout_seconds=self.follow_up_timeout_seconds,
                )
            except UtteranceTimeoutError:
                break
            if not follow_up.accepted or re.fullmatch(
                r"(?:goodbye|stop listening|that's all|that is all)",
                (follow_up.command or "").strip(),
                flags=re.IGNORECASE,
            ):
                break
        return None
