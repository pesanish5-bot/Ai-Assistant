from __future__ import annotations

import unittest

from voice.clap import AudioFrameFeatures, ClapConfig, DoubleClapDetector, extract_audio_features
from voice.interaction import EventName, InteractionEvent, LockStateRouter, SessionState, TtsPlaybackGate


def clap_features() -> AudioFrameFeatures:
    return AudioFrameFeatures(
        rms=0.12,
        peak=0.85,
        crest_factor=5.0,
        spectral_flatness=0.42,
        high_band_ratio=0.61,
        spectral_centroid_ratio=0.48,
        duration_ms=32.0,
    )


class DoubleClapTests(unittest.TestCase):
    def test_double_clap_timing_and_cooldown(self) -> None:
        detector = DoubleClapDetector(ClapConfig(required_claps=2, cooldown_ms=1_000))
        self.assertIsNone(detector.process_features(clap_features(), 1.0))
        event = detector.process_features(clap_features(), 1.35)
        self.assertIsNotNone(event)
        self.assertEqual(event.name, EventName.CLAP_ACTIVATION_DETECTED)
        self.assertEqual(event.payload["clap_count"], 2)
        self.assertEqual(event.payload["interval_ms"], 350)

        self.assertIsNone(detector.process_features(clap_features(), 1.6))
        self.assertIsNone(detector.process_features(clap_features(), 1.9))
        self.assertIsNone(detector.process_features(clap_features(), 2.4))
        event = detector.process_features(clap_features(), 2.7)
        self.assertIsNotNone(event)

    def test_rejects_speech_keyboard_and_narrow_impulse_features(self) -> None:
        detector = DoubleClapDetector()
        ordinary_speech = AudioFrameFeatures(0.10, 0.19, 1.9, 0.04, 0.10, 0.11, 32.0)
        keyboard = AudioFrameFeatures(0.018, 0.35, 8.0, 0.40, 0.62, 0.50, 32.0)
        narrow_door_noise = AudioFrameFeatures(0.20, 0.75, 3.75, 0.01, 0.08, 0.09, 32.0)
        for index, features in enumerate((ordinary_speech, keyboard, narrow_door_noise)):
            self.assertIsNone(detector.process_features(features, 1.0 + index))

    def test_detects_measured_low_gain_laptop_claps(self) -> None:
        detector = DoubleClapDetector()
        first = AudioFrameFeatures(0.0127, 0.0909, 7.18, 0.179, 0.566, 0.305, 32.0)
        event = detector.process_features(first, 1.0)
        self.assertIsNotNone(event)
        self.assertEqual(event.name, EventName.CLAP_ACTIVATION_DETECTED)
        self.assertEqual(event.payload["clap_count"], 1)
        self.assertEqual(event.payload["interval_ms"], 0)

    def test_tts_and_post_playback_gate_prevent_self_trigger(self) -> None:
        gate = TtsPlaybackGate(post_playback_ms=500)
        detector = DoubleClapDetector(ClapConfig(required_claps=2), tts_gate=gate)
        gate.playback_started(1.0)
        self.assertIsNone(detector.process_features(clap_features(), 1.1))
        self.assertIsNone(detector.process_features(clap_features(), 1.4))
        gate.playback_finished(1.5)
        self.assertIsNone(detector.process_features(clap_features(), 1.7))
        self.assertIsNone(detector.process_features(clap_features(), 1.9))
        self.assertIsNone(detector.process_features(clap_features(), 2.1))
        self.assertIsNotNone(detector.process_features(clap_features(), 2.4))

    def test_feature_extractor_reports_impulsive_broadband_signal(self) -> None:
        samples = [0.0] * 512
        samples[120:128] = [0.9, -0.8, 0.7, -0.9, 0.8, -0.7, 0.9, -0.8]
        features = extract_audio_features(samples, 16_000)
        self.assertGreater(features.peak, 0.8)
        self.assertGreater(features.crest_factor, 3.0)
        self.assertGreater(features.high_band_ratio, 0.0)
        self.assertEqual(features.duration_ms, 32.0)


class LockStateRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.event = InteractionEvent(EventName.CLAP_DOUBLE_DETECTED, 5.0, "test")

    def test_unlocked_opens_hud_and_listens(self) -> None:
        routed = LockStateRouter().route(self.event, SessionState.UNLOCKED)
        self.assertEqual(routed.name, EventName.HUD_OPEN_REQUESTED)
        self.assertTrue(routed.payload["enter_listening"])

    def test_locked_starts_prototype_auth_without_unlock(self) -> None:
        routed = LockStateRouter().route(self.event, SessionState.LOCKED)
        self.assertEqual(routed.name, EventName.AUTH_START_REQUESTED)
        self.assertFalse(routed.payload["os_unlock"])

    def test_unknown_lock_state_fails_closed(self) -> None:
        routed = LockStateRouter().route(self.event, SessionState.UNKNOWN)
        self.assertEqual(routed.name, EventName.ACTIVATION_REJECTED)


if __name__ == "__main__":
    unittest.main()
