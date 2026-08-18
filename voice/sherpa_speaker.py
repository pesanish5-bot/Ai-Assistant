"""Local sherpa-onnx CAM++ speaker embeddings for enrollment and verification."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import sherpa_onnx
import soundfile as sf

from .download_stage3_models import default_model_directory


SPEAKER_MODEL_NAME = "wespeaker_en_voxceleb_CAM++.onnx"
SPEAKER_MODEL_SHA256 = "c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef"
SPEAKER_SAMPLE_RATE = 16_000


def default_speaker_model() -> Path:
    return default_model_directory() / "sherpa-onnx" / SPEAKER_MODEL_NAME


def verify_speaker_model(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"Speaker model not found: {path}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != SPEAKER_MODEL_SHA256:
        raise RuntimeError(f"Speaker model checksum mismatch: {path}")


@dataclass(slots=True)
class SherpaOnnxSpeakerEmbeddingBackend:
    model_path: Path = field(default_factory=default_speaker_model)
    num_threads: int = 1
    _extractor: sherpa_onnx.SpeakerEmbeddingExtractor = field(init=False, repr=False)
    model_id: str = field(init=False)

    def __post_init__(self) -> None:
        self.model_path = self.model_path.expanduser().resolve()
        verify_speaker_model(self.model_path)
        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(self.model_path),
            num_threads=self.num_threads,
            debug=False,
            provider="cpu",
        )
        if not config.validate():
            raise ValueError("Invalid sherpa-onnx speaker model configuration")
        self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
        self.model_id = f"sherpa-onnx/{SPEAKER_MODEL_NAME}@{SPEAKER_MODEL_SHA256[:12]}"

    @property
    def dimension(self) -> int:
        return int(self._extractor.dim)

    def embedding_from_file(self, audio_path: Path) -> tuple[float, ...]:
        samples, sample_rate = sf.read(
            audio_path.expanduser().resolve(),
            dtype="float32",
            always_2d=True,
        )
        if sample_rate != SPEAKER_SAMPLE_RATE:
            raise ValueError(f"Speaker audio must be {SPEAKER_SAMPLE_RATE} Hz")
        mono = np.mean(samples, axis=1, dtype=np.float32)
        if len(mono) < SPEAKER_SAMPLE_RATE:
            raise ValueError("Speaker verification requires at least one second of speech")
        if len(mono) > SPEAKER_SAMPLE_RATE * 30:
            raise ValueError("Speaker verification audio cannot exceed 30 seconds")
        if not np.all(np.isfinite(mono)) or float(np.max(np.abs(mono))) < 1e-4:
            raise ValueError("Speaker audio is silent or invalid")

        stream = self._extractor.create_stream()
        stream.accept_waveform(SPEAKER_SAMPLE_RATE, mono.tolist())
        stream.input_finished()
        if not self._extractor.is_ready(stream):
            raise ValueError("Speaker model found insufficient usable speech")
        embedding = tuple(float(value) for value in self._extractor.compute(stream))
        if len(embedding) != self.dimension:
            raise RuntimeError("Speaker model returned an unexpected embedding size")
        return embedding
