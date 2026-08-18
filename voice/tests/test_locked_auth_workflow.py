from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from voice.auth_session import AuthenticationSessionController
from voice.authentication import AuthenticationConfig, AuthenticationPrototype, AuthenticationState
from voice.interaction import EventName, SessionState, TtsPlaybackGate
from voice.locked_auth_workflow import LockedAuthenticationWorkflow, TtsGatedAuthenticationSpeaker
from voice.security import MemorySecurityEventLog
from voice.speaker import MemorySpeakerProfileStore, SpeakerProfile


class Backend:
    model_id = "test-v1"

    def embedding_from_file(self, audio_path: Path):
        return (1.0, 0.0)


class Transcriber:
    challenge = ""

    def transcribe_file(self, audio_path: Path) -> str:
        return "I am Test User" if audio_path.name == "identity.wav" else self.challenge


class Liveness:
    def confidence(self, audio_path: Path, expected_challenge: str) -> float:
        return 0.95


class Recorder:
    def __init__(self, transcriber: Transcriber) -> None:
        self.transcriber = transcriber
        self.paths: list[Path] = []

    def capture(self, destination: Path) -> None:
        self.paths.append(destination)
        destination.write_bytes(b"temporary")


class Speaker:
    def __init__(self, transcriber: Transcriber) -> None:
        self.transcriber = transcriber
        self.messages: list[str] = []

    def speak(self, text: str) -> None:
        self.messages.append(text)
        if text.startswith("Say: "):
            self.transcriber.challenge = text.removeprefix("Say: ").removesuffix(".")


class EventCollector:
    def __init__(self) -> None:
        self.events = []

    def publish(self, event) -> None:
        self.events.append(event)


class LockedAuthenticationWorkflowTests(unittest.TestCase):
    def test_terminal_identity_failure_is_counted_once_when_failure_tts_breaks(self) -> None:
        class WrongBackend:
            model_id = "test-v1"

            def embedding_from_file(self, audio_path: Path):
                return (-1.0, 0.0)

        class FailOnSecondSpeech(Speaker):
            def speak(self, text: str) -> None:
                super().speak(text)
                if len(self.messages) == 2:
                    raise OSError("speaker unavailable")

        store = MemorySpeakerProfileStore()
        store.save(SpeakerProfile("test-user", "Test User", "test-v1", (1.0, 0.0), 5, "2026-08-11T00:00:00+00:00"))
        transcriber = Transcriber()
        security_log = MemorySecurityEventLog()
        prototype = AuthenticationPrototype(
            security_log,
            AuthenticationConfig(expected_identity="Test User"),
        )
        session = AuthenticationSessionController(
            prototype,
            WrongBackend(),
            store,
            transcriber,
            Liveness(),
            "test-user",
        )
        workflow = LockedAuthenticationWorkflow(
            session,
            Recorder(transcriber),
            FailOnSecondSpeech(transcriber),
            clock=lambda: 2.0,
        )
        decision = workflow.start(1.0, activation_method="double_clap", session_state=SessionState.LOCKED)
        self.assertEqual(decision.state, AuthenticationState.FAILED)
        self.assertEqual(prototype.throttler.consecutive_failures, 1)
        failures = [event for event in security_log.events if event["event"] == "auth.failed"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["reason_code"], "identity_failed")

    def test_dynamic_challenge_is_local_and_never_allows_os_unlock(self) -> None:
        profile_store = MemorySpeakerProfileStore()
        profile_store.save(
            SpeakerProfile(
                "test-user",
                "Test User",
                "test-v1",
                (1.0, 0.0),
                5,
                "2026-08-11T00:00:00+00:00",
            )
        )
        transcriber = Transcriber()
        recorder = Recorder(transcriber)
        speaker = Speaker(transcriber)
        session = AuthenticationSessionController(
            AuthenticationPrototype(
                MemorySecurityEventLog(),
                AuthenticationConfig(expected_identity="Test User"),
            ),
            Backend(),
            profile_store,
            transcriber,
            Liveness(),
            "test-user",
        )
        workflow = LockedAuthenticationWorkflow(session, recorder, speaker, clock=iter([2.0, 3.0, 4.0]).__next__)
        result = workflow.start(1.0, activation_method="double_clap", session_state=SessionState.LOCKED)
        self.assertEqual(result.state, AuthenticationState.VERIFIED_PROTOTYPE)
        self.assertTrue(result.authenticated)
        self.assertFalse(result.allows_os_unlock)
        self.assertEqual(len(recorder.paths), 2)
        self.assertTrue(all(not path.exists() for path in recorder.paths))
        self.assertTrue(any(message.startswith("Say: ") for message in speaker.messages))

    def test_io_failure_fails_closed(self) -> None:
        class FailingRecorder:
            def capture(self, destination: Path) -> None:
                raise OSError("microphone unavailable")

        store = MemorySpeakerProfileStore()
        transcriber = Transcriber()
        session = AuthenticationSessionController(
            AuthenticationPrototype(
                MemorySecurityEventLog(),
                AuthenticationConfig(expected_identity="Test User"),
            ),
            Backend(),
            store,
            transcriber,
            Liveness(),
            "test-user",
        )
        workflow = LockedAuthenticationWorkflow(session, FailingRecorder(), Speaker(transcriber), clock=lambda: 2.0)
        result = workflow.start(1.0, activation_method="double_clap", session_state=SessionState.LOCKED)
        self.assertEqual(result.state, AuthenticationState.FAILED)
        self.assertFalse(result.allows_os_unlock)

    def test_authentication_speech_uses_shared_self_trigger_gate(self) -> None:
        class FailingSpeaker:
            def speak(self, text: str) -> None:
                raise OSError("speaker unavailable")

        events = EventCollector()
        gate = TtsPlaybackGate(post_playback_ms=650)
        timestamps = iter([10.0, 11.0])
        speaker = TtsGatedAuthenticationSpeaker(
            FailingSpeaker(),
            gate,
            events,
            clock=timestamps.__next__,
        )

        with self.assertRaises(OSError):
            speaker.speak("Identify yourself.")

        self.assertEqual(
            [event.name for event in events.events],
            [EventName.VOICE_SPEAKING, EventName.VOICE_SPEAKING],
        )
        self.assertEqual(
            [event.payload["active"] for event in events.events],
            [True, False],
        )
        self.assertTrue(gate.is_suppressed(11.5))
        self.assertFalse(gate.is_suppressed(11.7))

    def test_session_change_during_authentication_fails_closed(self) -> None:
        store = MemorySpeakerProfileStore()
        transcriber = Transcriber()
        recorder = Recorder(transcriber)
        session = AuthenticationSessionController(
            AuthenticationPrototype(
                MemorySecurityEventLog(),
                AuthenticationConfig(expected_identity="Test User"),
            ),
            Backend(),
            store,
            transcriber,
            Liveness(),
            "test-user",
        )
        workflow = LockedAuthenticationWorkflow(
            session,
            recorder,
            Speaker(transcriber),
            clock=lambda: 2.0,
            session_guard=iter([True, False]).__next__,
        )

        result = workflow.start(
            1.0,
            activation_method="double_clap",
            session_state=SessionState.LOCKED,
        )

        self.assertEqual(result.state, AuthenticationState.FAILED)
        self.assertFalse(result.allows_os_unlock)
        self.assertEqual(recorder.paths, [])

    def test_session_change_during_liveness_inference_never_publishes_verification(self) -> None:
        lock_state = {"locked": True}

        class UnlockingLiveness:
            def confidence(self, audio_path: Path, expected_challenge: str) -> float:
                lock_state["locked"] = False
                return 0.95

        store = MemorySpeakerProfileStore()
        store.save(SpeakerProfile("test-user", "Test User", "test-v1", (1.0, 0.0), 5, "2026-08-11T00:00:00+00:00"))
        transcriber = Transcriber()
        events = EventCollector()
        session = AuthenticationSessionController(
            AuthenticationPrototype(
                MemorySecurityEventLog(),
                AuthenticationConfig(expected_identity="Test User"),
            ),
            Backend(),
            store,
            transcriber,
            UnlockingLiveness(),
            "test-user",
        )
        workflow = LockedAuthenticationWorkflow(
            session,
            Recorder(transcriber),
            Speaker(transcriber),
            events,
            clock=lambda: 2.0,
            session_guard=lambda: lock_state["locked"],
        )

        result = workflow.start(1.0, activation_method="double_clap", session_state=SessionState.LOCKED)

        self.assertEqual(result.state, AuthenticationState.FAILED)
        self.assertFalse(result.authenticated)
        self.assertFalse(result.allows_os_unlock)
        self.assertFalse(any(event.name is EventName.AUTH_PROTOTYPE_VERIFIED for event in events.events))


if __name__ == "__main__":
    unittest.main()
