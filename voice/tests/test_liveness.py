from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from voice.liveness import LocalAudioLivenessHeuristic


class LivenessHeuristicTests(unittest.TestCase):
    def test_silence_and_missing_challenge_fail_closed(self) -> None:
        detector = LocalAudioLivenessHeuristic()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "silence.wav"
            sf.write(path, np.zeros(16_000, dtype=np.float32), 16_000)
            self.assertEqual(detector.confidence(path, "seven amber delta"), 0.0)
            self.assertEqual(detector.confidence(path, ""), 0.0)

    def test_varied_speech_like_audio_passes_quality_gate(self) -> None:
        detector = LocalAudioLivenessHeuristic()
        rng = np.random.default_rng(7)
        time_axis = np.arange(32_000, dtype=np.float32) / 16_000
        envelope = 0.04 + 0.10 * np.square(np.sin(2 * np.pi * 2.3 * time_axis))
        voiced = 0.55 * np.sin(2 * np.pi * 181 * time_axis)
        broadband = 0.45 * rng.standard_normal(len(time_axis))
        samples = np.asarray(envelope * (voiced + broadband), dtype=np.float32)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "speech-like.wav"
            sf.write(path, samples, 16_000)
            self.assertGreaterEqual(detector.confidence(path, "seven amber delta"), 0.70)


if __name__ == "__main__":
    unittest.main()
