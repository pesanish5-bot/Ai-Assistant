"""Concrete local VAD, STT, and TTS adapters for conversational voice."""

from __future__ import annotations

import os
import logging
import sys
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
from .audio_devices import preferred_input_device, selected_output_device


SAMPLE_RATE = 16_000
MICHAEL_SPEAKER_ID = 6
_LOGGER = logging.getLogger(__name__)


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
        threshold: float = 0.45,
        silence_seconds: float = 1.1,
        timeout_seconds: float = 20.0,
        block_size: int = 512,
        clock: Callable[[], float] = time.perf_counter,
        capture_allowed: Callable[[], bool] | None = None,
        on_audio_level: Callable[[float], None] | None = None,
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
        self.on_audio_level = on_audio_level

    def capture(self, destination: Path, *, timeout_seconds: float | None = None) -> None:
        deadline_seconds = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        if deadline_seconds <= 0:
            raise ValueError("capture timeout must be positive")
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
                while self.clock() - started < deadline_seconds:
                    self._require_capture_allowed()
                    block, _overflowed = stream.read(self.block_size)
                    self._require_capture_allowed()
                    samples = np.asarray(block, dtype=np.float32).reshape(-1)
                    if self.on_audio_level is not None:
                        rms = float(np.sqrt(np.mean(samples * samples)))
                        try:
                            self.on_audio_level(min(1.0, max(0.0, (rms - 0.004) / 0.05)))
                        except Exception:
                            pass
                    vad.accept_waveform(samples)
                    completed = self._pop_completed(vad, np)
                    if completed is not None:
                        self._validate_speech(np, completed)
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
            self._validate_speech(np, completed)
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
    def _validate_speech(numpy_module: object, samples: object) -> None:
        data = numpy_module.asarray(samples, dtype=numpy_module.float32)  # type: ignore[attr-defined]
        duration = len(data) / SAMPLE_RATE
        if duration < 0.35:
            raise VoicePipelineError(VoicePipelineStage.CAPTURE, "speech was too short; please repeat")
        peak = float(numpy_module.max(numpy_module.abs(data)))  # type: ignore[attr-defined]
        rms = float(numpy_module.sqrt(numpy_module.mean(data * data)))  # type: ignore[attr-defined]
        clipped = float(numpy_module.mean(numpy_module.abs(data) >= 0.985))  # type: ignore[attr-defined]
        if not numpy_module.isfinite(rms) or rms < 0.003 or peak < 0.015 or clipped > 0.08:  # type: ignore[attr-defined]
            raise VoicePipelineError(VoicePipelineStage.CAPTURE, "microphone audio was unclear; please repeat")

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
    """Lazy local Whisper model with optional CUDA acceleration and CPU fallback."""

    def __init__(
        self, *, model_root: Path, language: str | None = None,
        model_size: str = "small", device: str = "auto",
    ) -> None:
        if model_size not in {"base", "small"}:
            raise ValueError("local Whisper model must be base or small")
        if device not in {"auto", "cpu", "cuda"}:
            raise ValueError("local Whisper device must be auto, cpu, or cuda")
        self.model_root = model_root.expanduser().resolve()
        self.language = language
        self.model_size = model_size
        self.device = device
        self._model: object | None = None
        self._active_device: str | None = None
        self._gpu_unavailable = False
        self._dll_handles: list[object] = []
        self._model_lock = threading.Lock()
        self._transcribe_lock = threading.Lock()

    def transcribe(self, audio_path: Path) -> str:
        # Wake recognition and an accepted clap can briefly overlap. Keep one
        # lazy model in memory and serialize inference instead of loading two
        # Whisper instances or invoking the same backend concurrently.
        with self._transcribe_lock:
            try:
                return self._infer(self._load_model(), audio_path)
            except Exception as error:
                if self.device != "auto" or self._active_device != "cuda":
                    raise VoicePipelineError(
                        VoicePipelineStage.TRANSCRIPTION, "local speech recognition failed",
                    ) from error
                _LOGGER.warning("CUDA speech recognition failed; switching to CPU")
                self._gpu_unavailable = True
                self._model = None
                self._active_device = None
                try:
                    return self._infer(self._load_model(), audio_path)
                except Exception as fallback_error:
                    raise VoicePipelineError(
                        VoicePipelineStage.TRANSCRIPTION, "local speech recognition failed",
                    ) from fallback_error

    def _infer(self, model: object, audio_path: Path) -> str:
        segments, _info = model.transcribe(  # type: ignore[attr-defined]
            str(audio_path),
            language=self.language,
            beam_size=5,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        accepted = []
        for segment in segments:
            # Reject weak short decodes over noise; never rewrite recognized words.
            if getattr(segment, "no_speech_prob", 0.0) > 0.75:
                continue
            if getattr(segment, "avg_logprob", 0.0) < -1.15:
                continue
            accepted.append(segment.text.strip())
        return " ".join(accepted).strip()

    def _load_model(self) -> object:
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is not None:
                return self._model
            try:
                from faster_whisper import WhisperModel

                selected = "cpu"
                if self.device != "cpu" and not self._gpu_unavailable:
                    try:
                        self._prepare_cuda_runtime()
                        import ctranslate2
                        if ctranslate2.get_cuda_device_count() < 1:
                            raise RuntimeError("no CUDA device")
                        self._model = WhisperModel(
                            self.model_size, device="cuda", compute_type="float16",
                            download_root=str(self.model_root), local_files_only=True,
                        )
                        selected = "cuda"
                    except Exception:
                        if self.device == "cuda":
                            raise
                        self._gpu_unavailable = True
                        _LOGGER.warning("CUDA speech recognition unavailable; using CPU")
                if self._model is None:
                    self._model = WhisperModel(
                        self.model_size, device="cpu", compute_type="int8",
                        download_root=str(self.model_root), local_files_only=True,
                    )
                self._active_device = selected
                return self._model
            except Exception as error:
                raise VoicePipelineError(
                    VoicePipelineStage.TRANSCRIPTION,
                    "local faster-whisper model is unavailable",
                ) from error

    def _prepare_cuda_runtime(self) -> None:
        if sys.platform != "win32":
            return
        root = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
        bins = [root / name / "bin" for name in ("cublas", "cudnn", "cuda_nvrtc")]
        if not all(path.is_dir() for path in bins):
            raise RuntimeError("NVIDIA CUDA runtime wheels are not installed")
        for path in bins:
            self._dll_handles.append(os.add_dll_directory(str(path)))
        os.environ["PATH"] = os.pathsep.join(map(str, bins)) + os.pathsep + os.environ.get("PATH", "")


class KokoroMichaelAdapter:
    """Generate Michael locally and play the generated samples from memory."""

    def __init__(
        self,
        *,
        model_directory: Path,
        device: int | None = None,
        threads: int = 4,
        speed: float = 1.0,
        gain: float = 1.8,
        playback_allowed: Callable[[], bool] | None = None,
        timing_reporter: Callable[[str, int], None] | None = None,
    ) -> None:
        if not 0.5 <= gain <= 3.0:
            raise ValueError("TTS gain must be between 0.5 and 3.0")
        self.model_directory = model_directory.expanduser().resolve()
        self.device = device
        self.threads = threads
        self.speed = speed
        self.gain = gain
        self.playback_allowed = playback_allowed
        self.timing_reporter = timing_reporter
        self._tts: object | None = None
        self._load_lock = threading.Lock()

    def prewarm(self) -> None:
        """Load the local model while voice is enabled, without opening a speaker."""
        import sherpa_onnx

        with self._load_lock:
            self._load_tts(sherpa_onnx)

    def speak(self, text: str) -> None:
        started = time.perf_counter()
        try:
            import sherpa_onnx
            import sounddevice as sd

            with self._load_lock:
                tts = self._load_tts(sherpa_onnx)
            generation = sherpa_onnx.GenerationConfig()
            generation.sid = MICHAEL_SPEAKER_ID
            generation.speed = self.speed
            generation.silence_scale = 0.2
            self._stream_generated_audio(sd, tts, text, generation, started)
        except VoicePipelineError:
            raise
        except Exception as error:
            raise VoicePipelineError(
                VoicePipelineStage.TTS,
                "local Kokoro Michael generation or playback failed",
            ) from error

    def _stream_generated_audio(
        self, sounddevice: object, tts: object, text: str,
        generation: object, started: float,
    ) -> None:
        """Play each Kokoro callback chunk instead of waiting for the full reply."""
        import numpy as np

        self._require_playback_allowed()
        sample_rate = int(tts.sample_rate)  # type: ignore[attr-defined]
        output_device = selected_output_device(sounddevice, self.device)
        sounddevice.check_output_settings(  # type: ignore[attr-defined]
            device=output_device, channels=1, samplerate=sample_rate,
        )
        block_size = max(1, round(sample_rate * 0.05))
        first_write = True

        with sounddevice.OutputStream(  # type: ignore[attr-defined]
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            device=output_device,
            blocksize=block_size,
        ) as stream:
            def play_chunk(samples: object, _progress: float) -> int:
                nonlocal first_write
                data = np.asarray(samples, dtype=np.float32)
                if len(data) == 0:
                    return 1  # sherpa-onnx continues generation on a nonzero result.
                peak = float(np.max(np.abs(data)))
                if peak > 0:
                    data = data * min(self.gain, 0.9 / peak)
                for offset in range(0, len(data), block_size):
                    self._require_playback_allowed()
                    stream.write(data[offset : offset + block_size].reshape(-1, 1))
                    if first_write:
                        first_write = False
                        self._report_timing("tts_first_audio", started)
                return 1

            audio = tts.generate(text, generation, play_chunk)  # type: ignore[attr-defined]
            if first_write:
                # Keep playback working if a future sherpa version omits callbacks.
                play_chunk(audio.samples, 1.0)
        self._report_timing("tts_stream_total", started)
        if first_write:
            raise RuntimeError("Kokoro generated no audio")

    def _play_samples(
        self,
        sounddevice: object,
        samples: object,
        sample_rate: int,
        *,
        on_first_write: Callable[[], None] | None = None,
    ) -> None:
        import numpy as np

        self._require_playback_allowed()
        output_device = selected_output_device(sounddevice, self.device)
        sounddevice.check_output_settings(  # type: ignore[attr-defined]
            device=output_device, channels=1, samplerate=sample_rate,
        )
        samples = np.asarray(samples, dtype=np.float32)
        peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
        if peak > 0:
            samples = samples * min(self.gain, 0.9 / peak)
        block_size = max(1, round(sample_rate * 0.05))
        with sounddevice.OutputStream(  # type: ignore[attr-defined]
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            device=output_device,
            blocksize=block_size,
        ) as stream:
            for start in range(0, len(samples), block_size):  # type: ignore[arg-type]
                self._require_playback_allowed()
                stream.write(samples[start : start + block_size].reshape(-1, 1))  # type: ignore[index]
                if start == 0 and on_first_write is not None:
                    on_first_write()

    def _report_timing(self, stage: str, started: float) -> None:
        if self.timing_reporter is None:
            return
        try:
            self.timing_reporter(stage, round((time.perf_counter() - started) * 1000))
        except Exception:
            pass

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
