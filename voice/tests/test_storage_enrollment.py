from __future__ import annotations

import io
import os
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from voice.enroll_speaker import run_enrollment
from voice.protection import WindowsUserDpapiProtector
from voice.security import ProtectedAttemptThrottler, ProtectedSecurityEventLog
from voice.speaker import (
    EncryptedFileSpeakerProfileStore,
    EnrollmentService,
    MemorySpeakerProfileStore,
    SpeakerProfile,
    resolve_speaker_name,
    speaker_profile_id,
)


@dataclass
class XorProtector:
    key: int = 0xA5

    def protect(self, plaintext: bytes) -> bytes:
        return bytes(value ^ self.key for value in plaintext)

    def unprotect(self, ciphertext: bytes) -> bytes:
        return bytes(value ^ self.key for value in ciphertext)


class FakeEmbeddingBackend:
    model_id = "fake-embedding-v1"

    def embedding_from_file(self, audio_path: Path) -> tuple[float, ...]:
        index = int(audio_path.stem.rsplit("-", 1)[-1])
        return (1.0, index / 10.0, 0.25)


class ProtectedStorageTests(unittest.TestCase):
    def test_attempt_throttle_survives_restart_in_protected_storage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "throttle.state"
            protector = XorProtector()
            first = ProtectedAttemptThrottler(path, protector)
            first.record_failure(10.0)
            raw = path.read_bytes()
            self.assertNotIn(b"consecutive_failures", raw)

            restarted = ProtectedAttemptThrottler(path, protector)
            self.assertEqual(restarted.consecutive_failures, 1)
            self.assertFalse(restarted.can_attempt(11.0))
            self.assertTrue(restarted.can_attempt(12.0))

    def test_corrupt_protected_throttle_state_fails_closed_at_setup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "throttle.state"
            path.write_bytes(b"not protected state")
            with self.assertRaises(Exception):
                ProtectedAttemptThrottler(path, XorProtector())

    def test_profile_file_is_protected_and_contains_only_profile_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = EncryptedFileSpeakerProfileStore(root, XorProtector())
            profile = SpeakerProfile(
                profile_id="profile-1",
                display_name="Test User",
                model_id="test-model",
                embedding=(0.9, 0.1),
                sample_count=3,
                created_at="2026-08-11T00:00:00+00:00",
            )
            store.save(profile)
            raw = next(root.iterdir()).read_bytes()
            self.assertNotIn(b"Test User", raw)
            self.assertNotIn(b"embedding", raw)
            self.assertEqual(store.load(profile.profile_id), profile)

    def test_security_log_rejects_sensitive_fields_and_protects_lines(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "security.jsonl"
            log = ProtectedSecurityEventLog(path, XorProtector())
            log.record(
                "auth.failed",
                1.0,
                activation_method="double_clap",
                speaker_verified=False,
                outcome="failed",
                os_unlock_attempted=False,
            )
            self.assertNotIn(b"auth.failed", path.read_bytes())
            self.assertEqual(log.read_events()[0]["outcome"], "failed")
            with self.assertRaises(ValueError):
                log.record("auth.failed", 2.0, password="forbidden")
            with self.assertRaises(ValueError):
                log.record("auth.failed", 2.0, transcript="forbidden")
            with self.assertRaises(ValueError):
                log.record("auth.failed", 2.0, raw_audio=b"forbidden")

    @unittest.skipUnless(os.name == "nt", "DPAPI is Windows-only")
    def test_windows_user_dpapi_round_trip(self) -> None:
        protector = WindowsUserDpapiProtector()
        plaintext = b"speaker-template-test"
        try:
            protected = protector.protect(plaintext)
        except OSError as error:
            self.skipTest(f"DPAPI is unavailable in this test account: {error}")
        self.assertNotEqual(protected, plaintext)
        self.assertEqual(protector.unprotect(protected), plaintext)


class EnrollmentTests(unittest.TestCase):
    def _sample_files(self, root: Path, count: int) -> list[Path]:
        samples: list[Path] = []
        for index in range(count):
            path = root / f"sample-{index}.wav"
            path.write_bytes(b"test fixture only")
            samples.append(path)
        return samples

    def test_one_sample_enrollment_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            samples = self._sample_files(Path(temporary), 1)
            with self.assertRaises(ValueError):
                EnrollmentService(FakeEmbeddingBackend(), MemorySpeakerProfileStore()).enroll(
                    "Test User", samples
                )
            output = io.StringIO()
            code = run_enrollment(
                ["--name", "Test User", "--sample", str(samples[0])],
                backend=FakeEmbeddingBackend(),
                store=MemorySpeakerProfileStore(),
                output=output,
            )
            self.assertEqual(code, 2)
            self.assertIn("at least 3", output.getvalue())

    def test_identity_must_be_explicit_and_profile_id_derivation_is_stable(self) -> None:
        with self.assertRaisesRegex(ValueError, "not configured"):
            resolve_speaker_name(environment={})
        self.assertEqual(
            resolve_speaker_name(environment={"ULTRON_SPEAKER_NAME": "  Test User  "}),
            "Test User",
        )
        self.assertEqual(speaker_profile_id("Test User"), "test-user")
        self.assertEqual(speaker_profile_id("  Test User  "), "test-user")

    def test_multi_sample_enrollment_stores_only_embedding_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            samples = self._sample_files(Path(temporary), 3)
            store = MemorySpeakerProfileStore()
            profile = EnrollmentService(FakeEmbeddingBackend(), store).enroll("Test User", samples)
            self.assertEqual(profile.sample_count, 3)
            self.assertEqual(profile.model_id, "fake-embedding-v1")
            self.assertEqual(store.load(profile.profile_id), profile)
            self.assertFalse(hasattr(profile, "raw_audio"))
            self.assertFalse(hasattr(profile, "password"))

    def test_cli_reports_success_only_after_store_save(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            samples = self._sample_files(Path(temporary), 3)
            output = io.StringIO()
            store = MemorySpeakerProfileStore()
            args = ["--name", "Test User"]
            for sample in samples:
                args.extend(("--sample", str(sample)))
            code = run_enrollment(args, backend=FakeEmbeddingBackend(), store=store, output=output)
            self.assertEqual(code, 0)
            self.assertIn("Speaker enrolled: Test User", output.getvalue())
            self.assertEqual(len(store.profiles), 1)


if __name__ == "__main__":
    unittest.main()
