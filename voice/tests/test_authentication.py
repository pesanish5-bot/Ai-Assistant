from __future__ import annotations

import random
import unittest

from voice.authentication import AuthenticationConfig, AuthenticationPrototype, AuthenticationState
from voice.interaction import SessionState
from voice.security import (
    AttemptThrottleConfig,
    AttemptThrottler,
    ChallengeGenerator,
    MemorySecurityEventLog,
)


def prototype() -> tuple[AuthenticationPrototype, MemorySecurityEventLog]:
    event_log = MemorySecurityEventLog()
    generator = ChallengeGenerator(random_source=random.Random(7))
    return AuthenticationPrototype(
        event_log,
        AuthenticationConfig(expected_identity="Test User"),
        challenge_generator=generator,
    ), event_log


class AuthenticationTests(unittest.TestCase):
    def test_default_challenge_has_high_entropy_and_unique_words(self) -> None:
        generator = ChallengeGenerator(random_source=random.Random(7))
        challenge = generator.generate(1.0)
        words = challenge.phrase.split()
        self.assertEqual(len(words), 5)
        self.assertEqual(len(words), len(set(words)))
        # Ordered sampling of five from this vocabulary exceeds 32 bits.
        possibilities = 1
        for remaining in range(len(generator.vocabulary), len(generator.vocabulary) - 5, -1):
            possibilities *= remaining
        self.assertGreaterEqual(possibilities, 2**32)

    def test_wrong_challenge_fails_closed_and_never_unlocks(self) -> None:
        auth, event_log = prototype()
        started = auth.start(10.0, activation_method="double_clap", session_state=SessionState.LOCKED)
        self.assertEqual(started.state, AuthenticationState.IDENTIFYING)
        issued = auth.submit_identity(
            11.0,
            claimed_identity="I am Test User",
            speaker_similarity=0.91,
        )
        self.assertIsNotNone(issued.challenge_phrase)
        failed = auth.submit_challenge(
            12.0,
            transcript="wrong challenge",
            speaker_similarity=0.94,
            liveness_confidence=0.91,
        )
        self.assertEqual(failed.state, AuthenticationState.FAILED)
        self.assertFalse(failed.authenticated)
        self.assertFalse(failed.allows_os_unlock)
        self.assertEqual(failed.public_message, "Authentication failed.")
        self.assertFalse(event_log.events[-1]["os_unlock_attempted"])

    def test_success_is_only_a_prototype_identity_gate(self) -> None:
        auth, event_log = prototype()
        auth.start(20.0, activation_method="double_clap", session_state=SessionState.LOCKED)
        issued = auth.submit_identity(
            21.0,
            claimed_identity="I am Test User.",
            speaker_similarity=0.92,
        )
        result = auth.submit_challenge(
            22.0,
            transcript=issued.challenge_phrase or "",
            speaker_similarity=0.90,
            liveness_confidence=0.88,
        )
        self.assertEqual(result.state, AuthenticationState.VERIFIED_PROTOTYPE)
        self.assertTrue(result.authenticated)
        self.assertFalse(result.allows_os_unlock)
        self.assertIn("Windows sign-in", result.public_message)
        self.assertEqual(event_log.events[-1]["outcome"], "verified_prototype_only")

    def test_unknown_or_unlocked_session_is_rejected(self) -> None:
        for state in (SessionState.UNKNOWN, SessionState.UNLOCKED):
            auth, _ = prototype()
            decision = auth.start(30.0, activation_method="double_clap", session_state=state)
            self.assertEqual(decision.state, AuthenticationState.FAILED)
            self.assertFalse(decision.allows_os_unlock)

    def test_challenge_timeout_fails(self) -> None:
        auth, _ = prototype()
        auth.start(40.0, activation_method="double_clap", session_state=SessionState.LOCKED)
        issued = auth.submit_identity(
            41.0,
            claimed_identity="Test User",
            speaker_similarity=0.95,
        )
        result = auth.submit_challenge(
            70.0,
            transcript=issued.challenge_phrase or "",
            speaker_similarity=0.95,
            liveness_confidence=0.95,
        )
        self.assertEqual(result.state, AuthenticationState.FAILED)

    def test_challenge_timeout_starts_after_prompt_playback(self) -> None:
        auth, _ = prototype()
        auth.start(40.0, activation_method="double_clap", session_state=SessionState.LOCKED)
        issued = auth.submit_identity(
            41.0,
            claimed_identity="Test User",
            speaker_similarity=0.95,
        )
        # Simulate slow local TTS. The user's reply budget begins only once the
        # changing phrase has actually finished playing.
        auth.mark_challenge_prompted(65.0)
        result = auth.submit_challenge(
            80.0,
            transcript=issued.challenge_phrase or "",
            speaker_similarity=0.95,
            liveness_confidence=0.95,
        )
        self.assertEqual(result.state, AuthenticationState.VERIFIED_PROTOTYPE)

    def test_failed_attempt_is_throttled(self) -> None:
        auth, _ = prototype()
        auth.start(80.0, activation_method="double_clap", session_state=SessionState.LOCKED)
        auth.submit_identity(81.0, claimed_identity="Someone Else", speaker_similarity=0.30)
        blocked = auth.start(81.5, activation_method="double_clap", session_state=SessionState.LOCKED)
        self.assertEqual(blocked.state, AuthenticationState.THROTTLED)
        allowed = auth.start(83.1, activation_method="double_clap", session_state=SessionState.LOCKED)
        self.assertEqual(allowed.state, AuthenticationState.IDENTIFYING)


class ThrottlerTests(unittest.TestCase):
    def test_progressive_delay_and_hard_lockout(self) -> None:
        throttler = AttemptThrottler(
            AttemptThrottleConfig(
                base_delay_seconds=1,
                maximum_delay_seconds=4,
                hard_lockout_after=4,
                hard_lockout_seconds=30,
            )
        )
        self.assertEqual(throttler.record_failure(0.0), 1)
        self.assertEqual(throttler.record_failure(2.0), 2)
        self.assertEqual(throttler.record_failure(5.0), 4)
        self.assertEqual(throttler.record_failure(10.0), 30)
        self.assertFalse(throttler.can_attempt(39.9))
        self.assertTrue(throttler.can_attempt(40.0))
        throttler.record_success()
        self.assertEqual(throttler.consecutive_failures, 0)


if __name__ == "__main__":
    unittest.main()
