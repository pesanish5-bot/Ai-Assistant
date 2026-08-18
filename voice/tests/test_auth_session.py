from __future__ import annotations

import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from voice.auth_session import AuthenticationSessionController
from voice.authentication import AuthenticationConfig, AuthenticationPrototype, AuthenticationState
from voice.interaction import SessionState
from voice.security import MemorySecurityEventLog
from voice.speaker import MemorySpeakerProfileStore, SpeakerProfile


class FakeBackend:
    model_id = "fake-v1"

    def embedding_from_file(self, audio_path: Path) -> tuple[float, ...]:
        return (1.0, 0.0) if "match" in audio_path.name else (0.0, 1.0)


@dataclass
class FakeTranscriber:
    challenge: str = ""

    def transcribe_file(self, audio_path: Path) -> str:
        if "identity" in audio_path.name:
            return "I am Test User."
        return self.challenge


class FakeLiveness:
    def __init__(self, score: float) -> None:
        self.score = score

    def confidence(self, audio_path: Path, expected_challenge: str) -> float:
        return self.score


class LockChangingLiveness:
    def __init__(self, lock_state: dict[str, bool]) -> None:
        self.lock_state = lock_state

    def confidence(self, audio_path: Path, expected_challenge: str) -> float:
        # Deterministically model Windows unlocking while inference is active.
        self.lock_state["locked"] = False
        return 0.95


class AuthenticationSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.log = MemorySecurityEventLog()
        self.prototype = AuthenticationPrototype(
            self.log,
            AuthenticationConfig(expected_identity="Test User"),
        )
        self.store = MemorySpeakerProfileStore()
        self.store.save(
            SpeakerProfile(
                profile_id="test-user",
                display_name="Test User",
                model_id="fake-v1",
                embedding=(1.0, 0.0),
                sample_count=5,
                created_at="2026-08-11T00:00:00+00:00",
            )
        )
        self.transcriber = FakeTranscriber()
        self.controller = AuthenticationSessionController(
            self.prototype,
            FakeBackend(),
            self.store,
            self.transcriber,
            FakeLiveness(0.95),
            "test-user",
        )

    def test_local_identity_and_dynamic_challenge_can_verify_prototype_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            identity = Path(temporary) / "identity-match.wav"
            challenge = Path(temporary) / "challenge-match.wav"
            identity.touch()
            challenge.touch()
            self.controller.begin(1.0, SessionState.LOCKED)
            issued = self.controller.submit_identity_audio(2.0, identity)
            self.assertEqual(issued.state, AuthenticationState.CHALLENGE_ISSUED)
            self.transcriber.challenge = issued.challenge_phrase or ""
            result = self.controller.submit_challenge_audio(3.0, challenge)
            self.assertEqual(result.state, AuthenticationState.VERIFIED_PROTOTYPE)
            self.assertFalse(result.allows_os_unlock)

    def test_missing_profile_fails_closed_without_sensitive_log_fields(self) -> None:
        controller = AuthenticationSessionController(
            self.prototype,
            FakeBackend(),
            MemorySpeakerProfileStore(),
            self.transcriber,
            FakeLiveness(0.95),
            "test-user",
        )
        with tempfile.TemporaryDirectory() as temporary:
            audio = Path(temporary) / "identity-match.wav"
            audio.touch()
            controller.begin(10.0, SessionState.LOCKED)
            result = controller.submit_identity_audio(11.0, audio)
        self.assertEqual(result.state, AuthenticationState.FAILED)
        self.assertFalse(result.authenticated)
        self.assertNotIn("transcript", self.log.events[-1])
        self.assertNotIn("speaker_similarity", self.log.events[-1])

    def test_liveness_failure_does_not_verify(self) -> None:
        self.controller.liveness_detector = FakeLiveness(0.1)
        with tempfile.TemporaryDirectory() as temporary:
            identity = Path(temporary) / "identity-match.wav"
            challenge = Path(temporary) / "challenge-match.wav"
            identity.touch()
            challenge.touch()
            self.controller.begin(20.0, SessionState.LOCKED)
            issued = self.controller.submit_identity_audio(21.0, identity)
            self.transcriber.challenge = issued.challenge_phrase or ""
            result = self.controller.submit_challenge_audio(22.0, challenge)
        self.assertEqual(result.state, AuthenticationState.FAILED)
        self.assertFalse(result.allows_os_unlock)

    def test_session_change_during_challenge_inference_fails_before_verification_commit(self) -> None:
        lock_state = {"locked": True}
        self.controller.liveness_detector = LockChangingLiveness(lock_state)
        self.controller.verification_guard = lambda: lock_state["locked"]

        with tempfile.TemporaryDirectory() as temporary:
            identity = Path(temporary) / "identity-match.wav"
            challenge = Path(temporary) / "challenge-match.wav"
            identity.touch()
            challenge.touch()
            self.controller.begin(30.0, SessionState.LOCKED)
            issued = self.controller.submit_identity_audio(31.0, identity)
            self.transcriber.challenge = issued.challenge_phrase or ""
            result = self.controller.submit_challenge_audio(32.0, challenge)

        self.assertEqual(result.state, AuthenticationState.FAILED)
        self.assertFalse(result.authenticated)
        self.assertFalse(result.allows_os_unlock)
        self.assertEqual(self.log.events[-1]["reason_code"], "session_state_changed")
        self.assertFalse(any(event["event"] == "auth.prototype_verified" for event in self.log.events))


if __name__ == "__main__":
    unittest.main()
