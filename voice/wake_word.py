"""Local wake recognition over the same microphone frames used for clap.

Silero endpoints candidate speech and local Whisper recognizes only a leading
"Ultron". The transcript never leaves the bounded worker or enters an event.
"""

from __future__ import annotations

import tempfile
import logging
import threading
import time
import wave
from array import array
from dataclasses import dataclass
from pathlib import Path
from queue import Empty, Full, Queue
from typing import Callable, Protocol, Sequence

from .adapters import SpeechToTextAdapter
from .conversation import (
    ConversationMode,
    LocalConversationalVoicePipeline,
    UtteranceCapture,
    VoiceMicrophoneError,
    VoicePipelineError,
    WakeWordParser,
)
from .interaction import EventName, InteractionEvent, TtsPlaybackGate


_LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class LocalWakeWordLoop:
    capture: UtteranceCapture
    stt: SpeechToTextAdapter
    pipeline: LocalConversationalVoicePipeline
    wake_word: WakeWordParser
    events: object
    clock: Callable[[], float] = time.time

    def listen_once(self) -> bool:
        with tempfile.TemporaryDirectory(prefix="ultron-wake-") as temporary:
            path = Path(temporary) / "candidate.wav"
            self.capture.capture(path)
            transcript = self.stt.transcribe(path)
        if not self.wake_word.detected(transcript):
            return False
        try:
            self.events.publish(  # type: ignore[attr-defined]
                InteractionEvent(EventName.VOICE_WAKE_DETECTED, self.clock(), "local-wake-word")
            )
        except Exception:
            pass
        if self.wake_word.parse(transcript, required=True):
            self.pipeline.run_preheard(transcript)
        else:
            self.pipeline.run_once(ConversationMode.DIRECT)
        return True

    def run(self, stop_event: threading.Event) -> None:
        while not stop_event.is_set():
            try:
                self.listen_once()
            except (VoiceMicrophoneError, VoicePipelineError):
                stop_event.wait(0.5)


class FrameWakeVad(Protocol):
    """Endpoint speech segments from frames on the existing microphone stream."""

    def accept(self, samples: Sequence[float], sample_rate: int) -> Sequence[float] | None: ...

    def speech_active(self) -> bool: ...

    def reset(self) -> None: ...


class FrameActivationDetector(Protocol):
    def process_samples(
        self,
        samples: Sequence[float],
        sample_rate: int,
        timestamp: float,
    ) -> InteractionEvent | None: ...


@dataclass(frozen=True, slots=True)
class _WakeResult:
    generation: int
    event: InteractionEvent | None


def write_temporary_pcm16_wave(
    destination: Path,
    samples: Sequence[float],
    sample_rate: int,
) -> None:
    """Write a worker-only WAV; its surrounding temporary directory owns it."""

    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    pcm = array(
        "h",
        (
            round(max(-1.0, min(1.0, float(sample))) * 32767.0)
            for sample in samples
        ),
    )
    with wave.open(str(destination), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.tobytes())


class BoundedWakeTranscriber:
    """At most one candidate is transcribed; later candidates are dropped.

    Model inference never blocks the microphone frame loop. HUD events stay
    coarse; a wake utterance containing a command is handed off only in memory.
    """

    def __init__(
        self,
        stt: SpeechToTextAdapter,
        parser: WakeWordParser | None = None,
        *,
        wave_writer: Callable[[Path, Sequence[float], int], None] = write_temporary_pcm16_wave,
    ) -> None:
        self.stt = stt
        self.parser = parser or WakeWordParser()
        self.wave_writer = wave_writer
        self._lock = threading.Lock()
        self._busy = False
        self._results: Queue[_WakeResult] = Queue(maxsize=1)
        self.submitted_count = 0
        self.dropped_count = 0
        self.last_error: Exception | None = None
        self._pending_transcript: tuple[float, float, str] | None = None

    @property
    def busy(self) -> bool:
        with self._lock:
            return self._busy

    def submit(
        self,
        samples: Sequence[float],
        sample_rate: int,
        timestamp: float,
        generation: int,
    ) -> bool:
        with self._lock:
            if self._busy:
                self.dropped_count += 1
                return False
            self._busy = True
            self.submitted_count += 1
        worker = threading.Thread(
            target=self._transcribe,
            args=(tuple(float(sample) for sample in samples), sample_rate, timestamp, generation),
            name="UltronWakeTranscriber",
            daemon=True,
        )
        worker.start()
        return True

    def poll(self) -> _WakeResult | None:
        try:
            result = self._results.get_nowait()
        except Empty:
            return None
        with self._lock:
            self._busy = False
        return result

    def take_pending_transcript(self, timestamp: float) -> str | None:
        """One-shot, in-process handoff; never include conversational text in HUD events."""

        with self._lock:
            pending, self._pending_transcript = self._pending_transcript, None
        if pending is None:
            return None
        event_timestamp, recorded_at, transcript = pending
        if event_timestamp != timestamp or time.monotonic() - recorded_at > 15.0:
            return None
        return transcript

    def _transcribe(
        self,
        samples: tuple[float, ...],
        sample_rate: int,
        timestamp: float,
        generation: int,
    ) -> None:
        event: InteractionEvent | None = None
        try:
            with tempfile.TemporaryDirectory(prefix="ultron-wake-") as temporary:
                path = Path(temporary) / "candidate.wav"
                self.wave_writer(path, samples, sample_rate)
                transcript = self.stt.transcribe(path)
            if self.parser.detected(transcript):
                if self.parser.parse(transcript, required=True):
                    with self._lock:
                        self._pending_transcript = (timestamp, time.monotonic(), transcript)
                event = InteractionEvent(
                    EventName.VOICE_WAKE_DETECTED,
                    timestamp,
                    "local-wake-word",
                )
            self.last_error = None
        except Exception as error:
            # Do not copy transcript/audio details into an event or log.
            self.last_error = error
        result = _WakeResult(generation, event)
        try:
            self._results.put_nowait(result)
        except Full:
            # The one-slot invariant should make this unreachable; fail closed
            # instead of creating an unbounded result backlog.
            pass


class SherpaSileroFrameVad:
    """Lazy local sherpa-onnx Silero VAD for the shared 16 kHz frame stream."""

    def __init__(
        self,
        model_path: Path,
        *,
        threshold: float = 0.5,
        silence_seconds: float = 1.25,
    ) -> None:
        self.model_path = model_path.expanduser().resolve()
        self.threshold = threshold
        self.silence_seconds = silence_seconds
        self._vad: object | None = None
        self._numpy: object | None = None

    def accept(self, samples: Sequence[float], sample_rate: int) -> Sequence[float] | None:
        if sample_rate != 16_000:
            raise ValueError("wake-word VAD requires the shared 16 kHz microphone stream")
        vad, np = self._load()
        vad.accept_waveform(np.asarray(samples, dtype=np.float32))  # type: ignore[attr-defined]
        if vad.empty():  # type: ignore[attr-defined]
            return None
        segment = vad.front  # type: ignore[attr-defined]
        completed = tuple(float(sample) for sample in segment.samples)
        vad.pop()  # type: ignore[attr-defined]
        return completed or None

    def reset(self) -> None:
        if self._vad is not None:
            self._vad.reset()  # type: ignore[attr-defined]

    def speech_active(self) -> bool:
        return bool(self._vad is not None and self._vad.is_speech_detected())  # type: ignore[attr-defined]

    def _load(self) -> tuple[object, object]:
        if self._vad is not None and self._numpy is not None:
            return self._vad, self._numpy
        if not self.model_path.is_file():
            raise FileNotFoundError(f"Silero VAD model is unavailable: {self.model_path}")
        import numpy as np
        import sherpa_onnx

        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(self.model_path)
        config.silero_vad.threshold = self.threshold
        config.silero_vad.min_silence_duration = self.silence_seconds
        config.silero_vad.min_speech_duration = 0.25
        config.silero_vad.max_speech_duration = 15.0
        config.silero_vad.window_size = 512
        config.sample_rate = 16_000
        config.num_threads = 1
        config.provider = "cpu"
        if not config.validate():
            raise ValueError("invalid local Silero wake-word VAD configuration")
        self._vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=20)
        self._numpy = np
        return self._vad, self._numpy


class CompositeActivationDetector:
    """Run clap and VAD over every frame from one microphone source."""

    def __init__(
        self,
        *,
        clap: FrameActivationDetector,
        wake_vad: FrameWakeVad,
        wake_worker: BoundedWakeTranscriber,
        tts_gate: TtsPlaybackGate,
        single_clap_confirmation_seconds: float = 0.4,
        wake_vad_retry_seconds: float = 3.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if single_clap_confirmation_seconds < 0:
            raise ValueError("single-clap confirmation must not be negative")
        if wake_vad_retry_seconds <= 0:
            raise ValueError("wake VAD retry interval must be positive")
        self.clap = clap
        self.wake_vad = wake_vad
        self.wake_worker = wake_worker
        self.tts_gate = tts_gate
        self._generation = 0
        self._was_suppressed = False
        self._wake_vad_available = True
        self._next_wake_vad_attempt = 0.0
        self.last_wake_vad_error: Exception | None = None
        self.wake_vad_retry_seconds = wake_vad_retry_seconds
        self.clock = clock
        self.single_clap_confirmation_seconds = single_clap_confirmation_seconds
        self._pending_single_clap: InteractionEvent | None = None

    def process_samples(
        self,
        samples: Sequence[float],
        sample_rate: int,
        timestamp: float,
    ) -> InteractionEvent | None:
        # Clap processing is unconditional; DoubleClapDetector applies the
        # same shared TTS gate internally and clears a partial clap sequence.
        clap_event = self.clap.process_samples(samples, sample_rate, timestamp)

        if self.tts_gate.is_suppressed(timestamp):
            if not self._was_suppressed:
                self._invalidate_wake()
            self._was_suppressed = True
            self._discard_stale_result()
            return clap_event

        if self._was_suppressed:
            self._invalidate_wake()
            self._was_suppressed = False

        ready = self.wake_worker.poll()
        completed: Sequence[float] | None = None
        speech_active = False
        if self._wake_vad_available or self.clock() >= self._next_wake_vad_attempt:
            try:
                completed = self.wake_vad.accept(samples, sample_rate)
                speech_active = self.wake_vad.speech_active()
                if not self._wake_vad_available:
                    _LOGGER.warning("local wake VAD recovered")
                self._wake_vad_available = True
                self.last_wake_vad_error = None
            except Exception as error:
                # Wake-word configuration must not take down the lightweight
                # clap path that shares this frame stream. Retry transient
                # device/model errors instead of disabling wake until restart.
                if self._wake_vad_available:
                    _LOGGER.warning("local wake VAD unavailable: %s", type(error).__name__)
                self.last_wake_vad_error = error
                self._wake_vad_available = False
                self._next_wake_vad_attempt = self.clock() + self.wake_vad_retry_seconds
                try:
                    self.wake_vad.reset()
                except Exception:
                    pass

        single_clap = (
            clap_event is not None
            and clap_event.name == EventName.CLAP_ACTIVATION_DETECTED
            and dict(clap_event.payload).get("clap_count") == 1
        )
        if clap_event is not None and not single_clap:
            self._invalidate_wake()
            return clap_event

        # A spoken plosive can resemble one clap. Give the shared VAD a short
        # look-ahead before letting a single impulse take over the microphone.
        if speech_active or completed is not None:
            self._pending_single_clap = None
        elif clap_event is not None:
            self._pending_single_clap = clap_event

        wake_event = self._current_event(ready)
        if wake_event is not None:
            self._invalidate_wake()
            return wake_event

        if completed is not None:
            self.wake_worker.submit(completed, sample_rate, timestamp, self._generation)
            wake_event = self._current_event(self.wake_worker.poll())
            if wake_event is not None:
                self._invalidate_wake()
                return wake_event
        pending = self._pending_single_clap
        if (
            pending is not None
            and timestamp - pending.timestamp >= self.single_clap_confirmation_seconds
        ):
            self._invalidate_wake()
            return pending
        return None

    def reset(self) -> None:
        self._invalidate_wake()
        reset_clap = getattr(self.clap, "reset", None)
        if reset_clap is not None:
            reset_clap()

    def _current_event(self, result: _WakeResult | None) -> InteractionEvent | None:
        if result is None or result.generation != self._generation:
            return None
        return result.event

    def _discard_stale_result(self) -> None:
        self.wake_worker.poll()

    def _invalidate_wake(self) -> None:
        self._generation += 1
        self._pending_single_clap = None
        if self._wake_vad_available:
            try:
                self.wake_vad.reset()
            except Exception as error:
                self.last_wake_vad_error = error
                self._wake_vad_available = False
                self._next_wake_vad_attempt = self.clock() + self.wake_vad_retry_seconds
                _LOGGER.warning("local wake VAD reset failed: %s", type(error).__name__)
        self._discard_stale_result()
