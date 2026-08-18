"""Concrete local VAD, STT, and TTS adapters for conversational voice."""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Callable

from .conversation import (
    UtteranceTimeoutError,
    VoiceMicrophoneError,
    VoicePipelineError,
    VoicePipelineStage,
)
from .audio_devices import preferred_input_device


SAMPLE_RATE = 16_000
MICHAEL_SPEAKER_ID = 6


def default_voice_model_root() -> Path:
    configured = os.environ.get("ULTRON_VOICE_MODEL_DIR")
    if configured:
        return Path(configured)
    return Path.home() / ".cache" / "ultron-voice" / "models"


class SileroVadMicrophoneCapture:
    """Capture one microphone utterance, endpointed locally by sherpa Silero VAD."""

    def __init__(
        self,
        *,
        model_path: Path,
        device: int | None = None,
        threshold: float = 0.5,
        silence_seconds: float = 0.7,
        timeout_seconds: float = 20.0,
        block_size: int = 512,
        clock: Callable[[], float] = time.perf_counter,
        capture_allowed: Callable[[], bool] | None = None,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if block_size <= 0:
            raise ValueError("block_size must be positive")
        self.model_path = model_path.expanduser().resolve()
        self.device = device
        self.threshold = threshold
        self.silence_seconds = silence_seconds
        self.timeout_seconds = timeout_seconds
        self.block_size = block_size
        self.clock = clock
        self.capture_allowed = capture_allowed

    def capture(self, destination: Path) -> None:
        if not self.model_path.is_file():
            raise VoicePipelineError(
                VoicePipelineStage.CAPTURE,
                f"Silero VAD model is unavailable: {self.model_path}",
            )
        try:
            import numpy as np
            import sherpa_onnx
            import sounddevice as sd
            import soundfile as sf
        except ImportError as error:
            raise VoicePipelineError(
                VoicePipelineStage.CAPTURE,
                "local VAD/microphone dependencies are unavailable",
            ) from error

        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(self.model_path)
        config.silero_vad.threshold = self.threshold
        config.silero_vad.min_silence_duration = self.silence_seconds
        config.silero_vad.min_speech_duration = 0.25
        config.silero_vad.max_speech_duration = 30.0
        config.silero_vad.window_size = self.block_size
        config.sample_rate = SAMPLE_RATE
        config.num_threads = 1
        config.provider = "cpu"
        if not config.validate():
            raise VoicePipelineError(
                VoicePipelineStage.CAPTURE,
                "Silero VAD configuration is invalid",
            )
        vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=30)

        started = self.clock()
        try:
            capture_device = self.device if self.device is not None else preferred_input_device(sd)
            with sd.InputStream(
                samplerate=SAMPLE_RATE,
                blocksize=self.block_size,
                channels=1,
                dtype="float32",
                device=capture_device,
            ) as stream:
                while self.clock() - started < self.timeout_seconds:
                    self._require_capture_allowed()
                    block, _overflowed = stream.read(self.block_size)
                    self._require_capture_allowed()
                    samples = np.asarray(block, dtype=np.float32).reshape(-1)
                    vad.accept_waveform(samples)
                    completed = self._pop_completed(vad, np)
                    if completed is not None:
                        self._write_wave(sf, destination, completed)
                        return
        except VoicePipelineError:
            raise
        except Exception as error:
            raise VoiceMicrophoneError("microphone could not capture an utterance") from error

        vad.flush()
        self._require_capture_allowed()
        completed = self._pop_completed(vad, np)
        if completed is not None:
            self._write_wave(sf, destination, completed)
            return
        raise UtteranceTimeoutError("no completed utterance was detected before timeout")

    def _require_capture_allowed(self) -> None:
        if self.capture_allowed is None:
            return
        try:
            allowed = self.capture_allowed()
        except Exception as error:
            raise VoiceMicrophoneError("microphone authorization could not be verified") from error
        if not allowed:
            raise VoiceMicrophoneError("microphone capture stopped because the Windows session changed")

    @staticmethod
    def _pop_completed(vad: object, numpy_module: object) -> object | None:
        if vad.empty():  # type: ignore[attr-defined]
            return None
        segment = vad.front  # type: ignore[attr-defined]
        samples = numpy_module.asarray(segment.samples, dtype=numpy_module.float32)
        vad.pop()  # type: ignore[attr-defined]
        return samples if len(samples) else None

    @staticmethod
    def _write_wave(soundfile_module: object, destination: Path, samples: object) -> None:
        try:
            soundfile_module.write(  # type: ignore[attr-defined]
                destination,
                samples,
                SAMPLE_RATE,
                subtype="PCM_16",
            )
        except Exception as error:
            raise VoicePipelineError(
                VoicePipelineStage.CAPTURE,
                "temporary microphone WAV could not be written",
            ) from error


class FasterWhisperSmallAdapter:
    """Lazy, local-only faster-whisper ``small`` model on CPU int8."""

    def __init__(self, *, model_root: Path, language: str | None = None) -> None:
        self.model_root = model_root.expanduser().resolve()
        self.language = language
        self._model: object | None = None
        self._model_lock = threading.Lock()
        self._transcribe_lock = threading.Lock()

    def transcribe(self, audio_path: Path) -> str:
        # Wake recognition and an accepted clap can briefly overlap. Keep one
        # lazy model in memory and serialize inference instead of loading two
        # Whisper instances or invoking the same backend concurrently.
        with self._transcribe_lock:
            model = self._load_model()
            segments, _info = model.transcribe(  # type: ignore[attr-defined]
                str(audio_path),
                language=self.language,
                beam_size=5,
                vad_filter=False,
            )
            return " ".join(segment.text.strip() for segment in segments).strip()

    def _load_model(self) -> object:
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is not None:
                return self._model
            try:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(
                    "small",
                    device="cpu",
                    compute_type="int8",
                    download_root=str(self.model_root),
                    local_files_only=True,
                )
                return self._model
            except Exception as error:
                raise VoicePipelineError(
                    VoicePipelineStage.TRANSCRIPTION,
                    "local faster-whisper small CPU-int8 model is unavailable",
                ) from error


class KokoroMichaelAdapter:
    """Generate Michael locally and play the generated samples from memory."""

    def __init__(
        self,
        *,
        model_directory: Path,
        device: int | None = None,
        threads: int = 4,
        speed: float = 1.0,
        playback_allowed: Callable[[], bool] | None = None,
    ) -> None:
        self.model_directory = model_directory.expanduser().resolve()
        self.device = device
        self.threads = threads
        self.speed = speed
        self.playback_allowed = playback_allowed
        self._tts: object | None = None

    def speak(self, text: str) -> None:
        try:
            import numpy as np
            import sherpa_onnx
            import sounddevice as sd

            tts = self._load_tts(sherpa_onnx)
            generation = sherpa_onnx.GenerationConfig()
            generation.sid = MICHAEL_SPEAKER_ID
            generation.speed = self.speed
            generation.silence_scale = 0.2
            audio = tts.generate(text, generation)  # type: ignore[attr-defined]
            samples = np.asarray(audio.samples, dtype=np.float32)
            if len(samples) == 0:
                raise RuntimeError("Kokoro generated no audio")
            self._play_samples(sd, samples, audio.sample_rate)
        except VoicePipelineError:
            raise
        except Exception as error:
            raise VoicePipelineError(
                VoicePipelineStage.TTS,
                "local Kokoro Michael generation or playback failed",
            ) from error

    def _play_samples(self, sounddevice: object, samples: object, sample_rate: int) -> None:
        self._require_playback_allowed()
        block_size = max(1, round(sample_rate * 0.05))
        with sounddevice.OutputStream(  # type: ignore[attr-defined]
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            device=self.device,
            blocksize=block_size,
        ) as stream:
            for start in range(0, len(samples), block_size):  # type: ignore[arg-type]
                self._require_playback_allowed()
                stream.write(samples[start : start + block_size].reshape(-1, 1))  # type: ignore[index]

    def _require_playback_allowed(self) -> None:
        if self.playback_allowed is None:
            return
        if not self.playback_allowed():
            raise VoicePipelineError(
                VoicePipelineStage.TTS,
                "local playback stopped because the Windows session changed",
            )

    def _load_tts(self, sherpa_onnx: object) -> object:
        if self._tts is not None:
            return self._tts
        required = (
            self.model_directory / "model.onnx",
            self.model_directory / "voices.bin",
            self.model_directory / "tokens.txt",
            self.model_directory / "espeak-ng-data",
        )
        missing = [str(path) for path in required if not path.exists()]
        if missing:
            raise VoicePipelineError(
                VoicePipelineStage.TTS,
                f"Kokoro model assets are unavailable: {', '.join(missing)}",
            )
        config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=str(required[0]),
                    voices=str(required[1]),
                    tokens=str(required[2]),
                    data_dir=str(required[3]),
                ),
                provider="cpu",
                debug=False,
                num_threads=self.threads,
            ),
            max_num_sentences=1,
        )
        if not config.validate():
            raise VoicePipelineError(
                VoicePipelineStage.TTS,
                "Kokoro Michael configuration is invalid",
            )
        self._tts = sherpa_onnx.OfflineTts(config)
        return self._tts
