"""Conservative local audio-quality checks for the authentication prototype.

This is defense in depth against obviously synthetic, silent, clipped, or
speaker-loop recordings. It is deliberately not represented as certified
anti-spoofing and can never authorize an operating-system unlock by itself.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf


@dataclass(frozen=True, slots=True)
class LocalAudioLivenessHeuristic:
    required_sample_rate: int = 16_000
    minimum_seconds: float = 0.8
    maximum_seconds: float = 12.0

    def confidence(self, audio_path: Path, expected_challenge: str) -> float:
        if not expected_challenge.strip():
            return 0.0
        samples, sample_rate = sf.read(
            audio_path.expanduser().resolve(), dtype="float32", always_2d=True
        )
        if sample_rate != self.required_sample_rate or samples.size == 0:
            return 0.0
        mono = np.mean(samples, axis=1, dtype=np.float32)
        if not np.all(np.isfinite(mono)):
            return 0.0

        duration = len(mono) / sample_rate
        if not self.minimum_seconds <= duration <= self.maximum_seconds:
            return 0.0

        absolute = np.abs(mono)
        rms = float(np.sqrt(np.mean(np.square(mono, dtype=np.float64))))
        peak = float(np.max(absolute))
        if rms < 0.003 or peak < 0.015:
            return 0.0

        frame_size = max(1, round(sample_rate * 0.025))
        usable = len(mono) - len(mono) % frame_size
        if usable < frame_size * 8:
            return 0.0
        frames = mono[:usable].reshape(-1, frame_size)
        envelope = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1))
        active_ratio = float(np.mean(envelope > max(0.004, rms * 0.32)))
        envelope_variation = float(np.std(envelope) / max(float(np.mean(envelope)), 1e-8))
        clipping_ratio = float(np.mean(absolute >= 0.985))
        crest_factor = peak / max(rms, 1e-8)

        window = np.hanning(len(mono))
        spectrum = np.abs(np.fft.rfft(mono * window))[1:]
        power = np.square(spectrum, dtype=np.float64) + 1e-12
        geometric = math.exp(float(np.mean(np.log(power))))
        spectral_flatness = geometric / float(np.mean(power))

        checks = (
            0.006 <= rms <= 0.35,
            clipping_ratio < 0.01,
            0.08 <= active_ratio <= 0.98,
            envelope_variation >= 0.12,
            1.4 <= crest_factor <= 20.0,
            0.00002 <= spectral_flatness <= 0.55,
        )
        return sum(checks) / len(checks)
