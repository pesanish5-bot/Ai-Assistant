from __future__ import annotations

import unittest
import threading
import time
from pathlib import Path

from voice.authentication import AuthenticationDecision, AuthenticationState
from voice.background_agent import ActivationDispatcher, ActivationMailbox
from voice.clap import DoubleClapDetector
from voice.conversation import ConversationMode, WakeWordParser
from voice.interaction import EventName, InteractionEvent, SessionState, TtsPlaybackGate
from voice.run_background import build_activation_host
from voice.wake_word import (
    BoundedWakeTranscriber,
    CompositeActivationDetector,
    LocalWakeWordLoop,
)
from voice.windows_activation import WindowsActivationController
from voice.windows_hud import HudOpenResult


class Capture:
    paths: list[Path]

    def __init__(self) -> None:
        self.paths = []

    def capture(self, destination: Path) -> None:
        self.paths.append(destination)
        destination.write_bytes(b"temporary")


class Stt:
    def __init__(self, transcript: str) -> None:
        self.transcript = transcript

    def transcribe(self, audio_path: Path) -> str:
        return self.transcript


class Pipeline:
    def __init__(self) -> None:
        self.modes: list[ConversationMode] = []

    def run_once(self, mode: ConversationMode):
        self.modes.append(mode)


class Events:
    def __init__(self) -> None:
        self.events = []

    def publish(self, event) -> None:
        self.events.append(event)


class WakeWordTests(unittest.TestCase):
    def test_ultron_wakes_the_shared_conversation_pipeline(self) -> None:
        capture, pipeline, events = Capture(), Pipeline(), Events()
        loop = LocalWakeWordLoop(capture, Stt("Ultron"), pipeline, WakeWordParser(), events)
        self.assertTrue(loop.listen_once())
        self.assertEqual(pipeline.modes, [ConversationMode.DIRECT])
        self.assertEqual(events.events[0].name, EventName.VOICE_WAKE_DETECTED)
        self.assertFalse(capture.paths[0].exists())

    def test_normal_speech_does_not_activate(self) -> None:
        pipeline, events = Pipeline(), Events()
        loop = LocalWakeWordLoop(Capture(), Stt("hello there"), pipeline, WakeWordParser(), events)
        self.assertFalse(loop.listen_once())
        self.assertEqual(pipeline.modes, [])
        self.assertEqual(events.events, [])


class FakeFrameClap:
    def __init__(self, gate: TtsPlaybackGate | None = None) -> None:
        self.gate = gate
        self.calls = 0

    def process_samples(self, samples, sample_rate, timestamp):
        self.calls += 1
        if self.gate and self.gate.is_suppressed(timestamp):
            return None
        if samples and samples[0] == 9.0:
            return InteractionEvent(EventName.CLAP_DOUBLE_DETECTED, timestamp, "fake-clap")
        return None


class FakeFrameVad:
    def __init__(self, *, every_frame: bool = False) -> None:
        self.every_frame = every_frame
        self.accepted = 0
        self.resets = 0

    def accept(self, samples, sample_rate):
        self.accepted += 1
        if self.every_frame or (samples and samples[0] == 1.0):
            return [0.2, -0.2] * 800
        return None

    def reset(self):
        self.resets += 1


class QueueWakeStt:
    def __init__(self, *transcripts: str) -> None:
        self.transcripts = list(transcripts)
        self.paths: list[Path] = []

    def transcribe(self, audio_path: Path) -> str:
        self.paths.append(audio_path)
        self.assert_path_exists = audio_path.is_file()
        return self.transcripts.pop(0)


def pump_for_event(detector, *, timeout: float = 1.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        event = detector.process_samples([0.0] * 512, 16_000, time.time())
        if event is not None:
            return event
        time.sleep(0.005)
    return None


class CompositeWakeDetectorTests(unittest.TestCase):
    def make_detector(self, stt, *, vad=None, gate=None, clap=None):
        gate = gate or TtsPlaybackGate(post_playback_ms=0)
        clap = clap or FakeFrameClap(gate)
        worker = BoundedWakeTranscriber(stt)
        detector = CompositeActivationDetector(
            clap=clap,
            wake_vad=vad or FakeFrameVad(),
            wake_worker=worker,
            tts_gate=gate,
        )
        return detector, worker, clap

    def test_one_stream_produces_both_clap_and_wake_paths(self) -> None:
        stt = QueueWakeStt("Ultron")
        detector, _worker, clap = self.make_detector(stt)

        clap_event = detector.process_samples([9.0] + [0.0] * 511, 16_000, 1.0)
        self.assertIsNotNone(clap_event)
        assert clap_event is not None
        self.assertEqual(clap_event.name, EventName.CLAP_DOUBLE_DETECTED)

        self.assertIsNone(detector.process_samples([1.0] + [0.0] * 511, 16_000, 2.0))
        wake_event = pump_for_event(detector)
        self.assertIsNotNone(wake_event)
        assert wake_event is not None
        self.assertEqual(wake_event.name, EventName.VOICE_WAKE_DETECTED)
        self.assertEqual(dict(wake_event.payload), {})
        self.assertNotIn("Ultron", repr(wake_event.to_dict()))
        self.assertGreaterEqual(clap.calls, 3)
        self.assertTrue(stt.assert_path_exists)
        self.assertFalse(stt.paths[0].exists())

    def test_ordinary_speech_does_not_emit_wake(self) -> None:
        stt = QueueWakeStt("hello there")
        detector, worker, _clap = self.make_detector(stt)
        detector.process_samples([1.0] + [0.0] * 511, 16_000, 1.0)
        deadline = time.monotonic() + 1.0
        events = []
        while time.monotonic() < deadline and worker.busy:
            event = detector.process_samples([0.0] * 512, 16_000, time.time())
            if event:
                events.append(event)
            time.sleep(0.005)
        self.assertEqual(events, [])
        self.assertFalse(worker.busy)
        self.assertFalse(stt.paths[0].exists())

    def test_shared_tts_gate_suppresses_and_resets_both_detectors(self) -> None:
        gate = TtsPlaybackGate(post_playback_ms=500)
        vad = FakeFrameVad(every_frame=True)
        clap = FakeFrameClap(gate)
        stt = QueueWakeStt("Ultron")
        detector, worker, _ = self.make_detector(stt, vad=vad, gate=gate, clap=clap)

        gate.playback_started(1.0)
        self.assertIsNone(detector.process_samples([9.0] + [0.0] * 511, 16_000, 1.1))
        self.assertEqual(vad.accepted, 0)
        self.assertGreaterEqual(vad.resets, 1)
        self.assertEqual(worker.submitted_count, 0)
        gate.playback_finished(2.0)
        self.assertIsNone(detector.process_samples([1.0] + [0.0] * 511, 16_000, 2.2))
        self.assertEqual(vad.accepted, 0)
        detector.process_samples([1.0] + [0.0] * 511, 16_000, 2.6)
        wake = pump_for_event(detector)
        self.assertIsNotNone(wake)
        assert wake is not None
        self.assertEqual(wake.name, EventName.VOICE_WAKE_DETECTED)

    def test_single_worker_is_bounded_while_transcription_blocks(self) -> None:
        started = threading.Event()
        release = threading.Event()

        class BlockingStt(QueueWakeStt):
            def transcribe(self, audio_path: Path) -> str:
                self.paths.append(audio_path)
                started.set()
                release.wait(1.0)
                return "ordinary speech"

        stt = BlockingStt()
        vad = FakeFrameVad(every_frame=True)
        detector, worker, _clap = self.make_detector(stt, vad=vad)
        detector.process_samples([0.1] * 512, 16_000, 1.0)
        self.assertTrue(started.wait(1.0))
        for index in range(8):
            detector.process_samples([0.1] * 512, 16_000, 1.1 + index / 100.0)
        self.assertEqual(worker.submitted_count, 1)
        self.assertGreaterEqual(worker.dropped_count, 8)
        vad.every_frame = False
        release.set()
        deadline = time.monotonic() + 1.0
        while worker.busy and time.monotonic() < deadline:
            detector.process_samples([0.0] * 512, 16_000, time.time())
            time.sleep(0.005)
        self.assertFalse(worker.busy)
        self.assertFalse(stt.paths[0].exists())

    def test_background_host_uses_lazy_composite_detector_by_default(self) -> None:
        host = build_activation_host(hud_token="x" * 32)
        self.assertIsInstance(host.clap_agent.detector, CompositeActivationDetector)
        detector = host.clap_agent.detector
        assert isinstance(detector, CompositeActivationDetector)
        self.assertIsInstance(detector.clap, DoubleClapDetector)
        self.assertEqual(detector.clap.config.required_claps, 1)
        self.assertFalse(detector.wake_worker.busy)

    def test_wake_vad_failure_does_not_take_down_clap(self) -> None:
        class BrokenVad(FakeFrameVad):
            def accept(self, samples, sample_rate):
                raise FileNotFoundError("wake model missing")

        detector, _worker, clap = self.make_detector(
            QueueWakeStt("unused"),
            vad=BrokenVad(),
        )
        event = detector.process_samples([9.0] + [0.0] * 511, 16_000, 1.0)
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event.name, EventName.CLAP_DOUBLE_DETECTED)
        self.assertEqual(clap.calls, 1)
        self.assertIsInstance(detector.last_wake_vad_error, FileNotFoundError)


class FixedSession:
    def __init__(self, state: SessionState) -> None:
        self.state = state

    def current_state(self) -> SessionState:
        return self.state


class FakeHud:
    def __init__(self) -> None:
        self.calls = 0

    def open_or_focus(self):
        self.calls += 1
        return HudOpenResult(True, False, True, True, False, hwnd=1)


class FakeListener:
    def __init__(self) -> None:
        self.calls = 0

    def start_listening(self, timestamp: float):
        self.calls += 1
        return InteractionEvent(EventName.VOICE_LISTENING, timestamp, "test")


class FakeAuth:
    def __init__(self) -> None:
        self.calls = 0

    def start(self, timestamp, *, activation_method, session_state):
        self.calls += 1
        return AuthenticationDecision(
            AuthenticationState.IDENTIFYING,
            "Identify yourself.",
            InteractionEvent(EventName.AUTH_STARTED, timestamp, "test"),
        )


class WakeActivationRoutingTests(unittest.TestCase):
    def test_unlocked_wake_opens_hud_and_enters_listening(self) -> None:
        hud, listener, auth = FakeHud(), FakeListener(), FakeAuth()
        controller = WindowsActivationController(
            FixedSession(SessionState.UNLOCKED), hud, listener, auth
        )
        mailbox = ActivationMailbox()
        mailbox.publish(InteractionEvent(EventName.VOICE_WAKE_DETECTED, 3.0, "test"))
        outcome = ActivationDispatcher(mailbox, controller).dispatch_once(0)
        self.assertIsNotNone(outcome)
        assert outcome is not None
        self.assertTrue(outcome.listening_started)
        self.assertEqual(hud.calls, 1)
        self.assertEqual(listener.calls, 1)
        self.assertEqual(auth.calls, 0)

    def test_locked_or_unknown_wake_rejects_without_auth_or_unlock(self) -> None:
        for state in (SessionState.LOCKED, SessionState.UNKNOWN):
            with self.subTest(state=state):
                hud, listener, auth = FakeHud(), FakeListener(), FakeAuth()
                controller = WindowsActivationController(FixedSession(state), hud, listener, auth)
                outcome = controller.handle(
                    InteractionEvent(EventName.VOICE_WAKE_DETECTED, 3.0, "test")
                )
                self.assertEqual(outcome.routed_event.name, EventName.ACTIVATION_REJECTED)
                self.assertFalse(outcome.listening_started)
                self.assertEqual(hud.calls, 0)
                self.assertEqual(listener.calls, 0)
                self.assertEqual(auth.calls, 0)
                self.assertIsNone(outcome.authentication)


if __name__ == "__main__":
    unittest.main()
