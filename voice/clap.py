"""Lightweight local double-clap feature extraction and timing detector."""

from __future__ import annotations

import cmath
import math
from dataclasses import dataclass, field
from typing import Sequence

from .interaction import EventName, InteractionEvent, TtsPlaybackGate


@dataclass(frozen=True, slots=True)
class AudioFrameFeatures:
    rms: float
    peak: float
    crest_factor: float
    spectral_flatness: float
    high_band_ratio: float
    spectral_centroid_ratio: float
    duration_ms: float

    def __post_init__(self) -> None:
        values = (
            self.rms,
            self.peak,
            self.crest_factor,
            self.spectral_flatness,
            self.high_band_ratio,
            self.spectral_centroid_ratio,
            self.duration_ms,
        )
        if any(not math.isfinite(value) or value < 0 for value in values):
            raise ValueError("audio frame features must be finite and non-negative")
        if self.duration_ms == 0:
            raise ValueError("audio frame duration must be positive")


@dataclass(frozen=True, slots=True)
class ClapConfig:
    enabled: bool = True
    required_claps: int = 1
    double_clap_window_ms: int = 800
    minimum_gap_ms: int = 160
    # Laptop microphone gain varies widely. These floors include quiet real
    # claps while the shape constraints below reject steady speech/noise.
    minimum_energy: float = 0.007
    minimum_peak: float = 0.035
    minimum_crest_factor: float = 4.0
    maximum_crest_factor: float = 7.5
    minimum_spectral_flatness: float = 0.055
    minimum_high_band_ratio: float = 0.28
    minimum_centroid_ratio: float = 0.16
    maximum_impulse_frame_ms: float = 100.0
    cooldown_ms: int = 1_500

    def __post_init__(self) -> None:
        if self.required_claps not in {1, 2}:
            raise ValueError("required_claps must be one or two")
        if not 0 < self.minimum_gap_ms < self.double_clap_window_ms:
            raise ValueError("minimum_gap_ms must be below double_clap_window_ms")
        if self.cooldown_ms < 0:
            raise ValueError("cooldown_ms cannot be negative")
        for name in (
            "minimum_energy",
            "minimum_peak",
            "minimum_crest_factor",
            "maximum_crest_factor",
            "minimum_spectral_flatness",
            "minimum_high_band_ratio",
            "minimum_centroid_ratio",
            "maximum_impulse_frame_ms",
        ):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} cannot be negative")
        if self.maximum_crest_factor < self.minimum_crest_factor:
            raise ValueError("maximum_crest_factor must not be below its minimum")


def extract_audio_features(samples: Sequence[float], sample_rate: int) -> AudioFrameFeatures:
    """Extract clap-oriented energy, impulsiveness, and spectral features.

    The radix-2 FFT is implemented with the standard library so the always-on
    detector does not require Whisper or another heavy model.
    """

    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    if len(samples) < 8:
        raise ValueError("at least eight samples are required")
    values = [float(sample) for sample in samples]
    if any(not math.isfinite(sample) for sample in values):
        raise ValueError("samples must be finite")

    rms = math.sqrt(sum(sample * sample for sample in values) / len(values))
    peak = max(abs(sample) for sample in values)
    crest = peak / max(rms, 1e-12)

    fft_size = 1 << (len(values).bit_length() - 1)
    windowed = [
        values[index] * (0.5 - 0.5 * math.cos(2 * math.pi * index / max(fft_size - 1, 1)))
        for index in range(fft_size)
    ]
    spectrum = _fft([complex(sample, 0.0) for sample in windowed])[: fft_size // 2 + 1]
    powers = [max((bin_value.real**2 + bin_value.imag**2), 1e-20) for bin_value in spectrum[1:]]
    total_power = sum(powers)
    nyquist = sample_rate / 2.0
    bin_width = sample_rate / fft_size
    frequencies = [(index + 1) * bin_width for index in range(len(powers))]
    high_cutoff = min(1_500.0, nyquist * 0.5)
    high_power = sum(power for power, frequency in zip(powers, frequencies) if frequency >= high_cutoff)
    centroid = sum(power * frequency for power, frequency in zip(powers, frequencies)) / max(total_power, 1e-20)
    geometric_mean = math.exp(sum(math.log(power) for power in powers) / len(powers))
    arithmetic_mean = total_power / len(powers)

    return AudioFrameFeatures(
        rms=rms,
        peak=peak,
        crest_factor=crest,
        spectral_flatness=geometric_mean / max(arithmetic_mean, 1e-20),
        high_band_ratio=high_power / max(total_power, 1e-20),
        spectral_centroid_ratio=centroid / max(nyquist, 1.0),
        duration_ms=len(values) / sample_rate * 1000.0,
    )


def _fft(values: list[complex]) -> list[complex]:
    size = len(values)
    if size == 0 or size & (size - 1):
        raise ValueError("FFT input length must be a power of two")

    output = list(values)
    target = 0
    for index in range(1, size):
        bit = size >> 1
        while target & bit:
            target ^= bit
            bit >>= 1
        target ^= bit
        if index < target:
            output[index], output[target] = output[target], output[index]

    length = 2
    while length <= size:
        root = cmath.exp(-2j * math.pi / length)
        for start in range(0, size, length):
            weight = 1 + 0j
            half = length // 2
            for offset in range(half):
                even = output[start + offset]
                odd = output[start + offset + half] * weight
                output[start + offset] = even + odd
                output[start + offset + half] = even - odd
                weight *= root
        length <<= 1
    return output


@dataclass(slots=True)
class DoubleClapDetector:
    config: ClapConfig = field(default_factory=ClapConfig)
    tts_gate: TtsPlaybackGate | None = None
    _first_clap_at: float | None = field(default=None, init=False)
    _cooldown_until: float = field(default=0.0, init=False)

    def process_samples(
        self,
        samples: Sequence[float],
        sample_rate: int,
        timestamp: float,
    ) -> InteractionEvent | None:
        return self.process_features(extract_audio_features(samples, sample_rate), timestamp)

    def process_features(
        self,
        features: AudioFrameFeatures,
        timestamp: float,
    ) -> InteractionEvent | None:
        if timestamp < 0:
            raise ValueError("timestamp must be non-negative")
        if not self.config.enabled:
            self._first_clap_at = None
            return None
        if self.tts_gate and self.tts_gate.is_suppressed(timestamp):
            self._first_clap_at = None
            return None
        if timestamp < self._cooldown_until:
            return None

        maximum_window = self.config.double_clap_window_ms / 1000.0
        minimum_gap = self.config.minimum_gap_ms / 1000.0
        if self._first_clap_at is not None and timestamp - self._first_clap_at > maximum_window:
            self._first_clap_at = None
        if not self._is_clap_candidate(features):
            return None

        if self.config.required_claps == 1:
            self._first_clap_at = None
            self._cooldown_until = timestamp + self.config.cooldown_ms / 1000.0
            return InteractionEvent(
                EventName.CLAP_ACTIVATION_DETECTED,
                timestamp,
                "clap-detector",
                {"clap_count": 1, "interval_ms": 0},
            )

        if self._first_clap_at is None:
            self._first_clap_at = timestamp
            return None

        gap = timestamp - self._first_clap_at
        if gap < minimum_gap:
            return None
        if gap <= maximum_window:
            self._first_clap_at = None
            self._cooldown_until = timestamp + self.config.cooldown_ms / 1000.0
            return InteractionEvent(
                EventName.CLAP_ACTIVATION_DETECTED,
                timestamp,
                "double-clap-detector",
                {"clap_count": 2, "interval_ms": round(gap * 1000)},
            )

        self._first_clap_at = timestamp
        return None

    def _is_clap_candidate(self, features: AudioFrameFeatures) -> bool:
        return (
            features.duration_ms <= self.config.maximum_impulse_frame_ms
            and features.rms >= self.config.minimum_energy
            and features.peak >= self.config.minimum_peak
            and features.crest_factor >= self.config.minimum_crest_factor
            and features.crest_factor <= self.config.maximum_crest_factor
            and features.spectral_flatness >= self.config.minimum_spectral_flatness
            and features.high_band_ratio >= self.config.minimum_high_band_ratio
            and features.spectral_centroid_ratio >= self.config.minimum_centroid_ratio
        )
