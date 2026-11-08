from __future__ import annotations

import unittest
import threading
import time
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from voice.authentication import AuthenticationDecision, AuthenticationState
from voice.background_agent import ActivationDispatcher, ActivationMailbox
from voice.clap import DoubleClapDetector
from voice.conversation import ConversationMode, WakeWordParser
from voice.interaction import EventName, InteractionEvent, SessionState, TtsPlaybackGate
from voice.run_background import BestEffortHudSink, build_activation_host, publish_outcome
from voice.wake_word import (
    BoundedWakeTranscriber,
    CompositeActivationDetector,
    LocalWakeWordLoop,
)
from voice.windows_activation import ActivationOutcome, WindowsActivationController
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
        self.preheard: list[str] = []

    def run_once(self, mode: ConversationMode):
        self.modes.append(mode)

    def run_preheard(self, transcript: str):
        self.preheard.append(transcript)


class Events:
    def __init__(self) -> None:
        self.events = []

    def publish(self, event) -> None:
        self.events.append(event)


class WakeWordTests(unittest.TestCase):
    def test_hud_delivery_reports_failure_and_recovery_without_payload(self) -> None:
        class FlakyAdapter:
            calls = 0

            def publish(self, _event):
                self.calls += 1
                if self.calls == 1:
                    raise OSError("private diagnostic detail")

        sink = BestEffortHudSink(FlakyAdapter())
        event = InteractionEvent(EventName.VOICE_LISTENING, 1.0, "test", {"active": True})
        output = StringIO()
        with redirect_stdout(output):
            sink.publish(event)
            sink.publish(event)
        self.assertIn("failure=OSError", output.getvalue())
        self.assertIn("recovered=true", output.getvalue())
        self.assertNotIn("private diagnostic detail", output.getvalue())

    def test_activation_log_identifies_method_without_spoken_text(self) -> None:
        for source, expected in (("wake-word-router", "wake_word"), ("lock-state-router", "clap")):
            with self.subTest(source=source):
                output = StringIO()
                event = InteractionEvent(EventName.HUD_OPEN_REQUESTED, 1.0, source)
                with redirect_stdout(output):
                    publish_outcome(ActivationOutcome(event, ()), Events())
                self.assertIn(f"method={expected}", output.getvalue())
                self.assertIn("hud_ready=False foreground=False visibility_fallback=False", output.getvalue())
                self.assertNotIn("spoken question", output.getvalue())

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

    def test_legacy_wake_loop_preserves_question_in_same_utterance(self) -> None:
        pipeline, events = Pipeline(), Events()
        phrase = "Ultron, when is the match between Brazil and India?"
        loop = LocalWakeWordLoop(Capture(), Stt(phrase), pipeline, WakeWordParser(), events)
        self.assertTrue(loop.listen_once())
        self.assertEqual(pipeline.preheard, [phrase])
        self.assertEqual(pipeline.modes, [])


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


class FakeSingleClap(FakeFrameClap):
    def process_samples(self, samples, sample_rate, timestamp):
        self.calls += 1
        if self.gate and self.gate.is_suppressed(timestamp):
            return None
        if samples and samples[0] == 9.0:
            return InteractionEvent(
                EventName.CLAP_ACTIVATION_DETECTED,
                timestamp,
                "fake-clap",
                {"clap_count": 1},
            )
        return None


class FakeFrameVad:
    def __init__(self, *, every_frame: bool = False) -> None:
        self.every_frame = every_frame
        self.accepted = 0
        self.resets = 0
        self.active = False

    def accept(self, samples, sample_rate):
        self.accepted += 1
        if self.every_frame or (samples and samples[0] == 1.0):
            return [0.2, -0.2] * 800
        return None

    def reset(self):
        self.resets += 1
        self.active = False

    def speech_active(self):
        return self.active


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

    def test_single_clap_activates_after_short_speech_check(self) -> None:
        detector, _worker, _clap = self.make_detector(
            QueueWakeStt("unused"), clap=FakeSingleClap()
        )
        self.assertIsNone(detector.process_samples([9.0] + [0.0] * 511, 16_000, 1.0))
        self.assertIsNone(detector.process_samples([0.0] * 512, 16_000, 1.39))
        event = detector.process_samples([0.0] * 512, 16_000, 1.41)
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event.name, EventName.CLAP_ACTIVATION_DETECTED)

    def test_speech_after_impulse_cancels_single_clap_and_preserves_wake(self) -> None:
        vad = FakeFrameVad()
        detector, _worker, _clap = self.make_detector(
            QueueWakeStt("Ultron, how are you?"), vad=vad, clap=FakeSingleClap()
        )
        self.assertIsNone(detector.process_samples([9.0] + [0.0] * 511, 16_000, 1.0))
        vad.active = True
        self.assertIsNone(detector.process_samples([0.2] * 512, 16_000, 1.2))
        vad.active = False
        self.assertIsNone(detector.process_samples([1.0] + [0.0] * 511, 16_000, 1.5))
        event = pump_for_event(detector)
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event.name, EventName.VOICE_WAKE_DETECTED)

    def test_tts_clears_pending_single_clap(self) -> None:
        gate = TtsPlaybackGate(post_playback_ms=0)
        detector, _worker, _clap = self.make_detector(
            QueueWakeStt("unused"), gate=gate, clap=FakeSingleClap(gate)
        )
        self.assertIsNone(detector.process_samples([9.0] + [0.0] * 511, 16_000, 1.0))
        gate.playback_started(1.1)
        self.assertIsNone(detector.process_samples([0.0] * 512, 16_000, 1.2))
        gate.playback_finished(1.3)
        self.assertIsNone(detector.process_samples([0.0] * 512, 16_000, 1.5))

    def test_wake_and_question_are_handed_to_core_once_without_hud_leak(self) -> None:
        phrase = "Ultron, when is the match between Brazil and India?"
        detector, worker, _clap = self.make_detector(QueueWakeStt(phrase))
        self.assertIsNone(detector.process_samples([1.0] + [0.0] * 511, 16_000, 12.0))
        event = pump_for_event(detector)
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event.name, EventName.VOICE_WAKE_DETECTED)
        self.assertEqual(dict(event.payload), {})
        self.assertEqual(worker.take_pending_transcript(12.0), phrase)
        self.assertIsNone(worker.take_pending_transcript(12.0))

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
        self.assertEqual(detector.clap.config.required_claps, 2)
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

    def test_wake_vad_recovers_after_a_transient_failure_without_host_restart(self) -> None:
        now = [0.0]

        class FlakyVad(FakeFrameVad):
            def accept(self, samples, sample_rate):
                self.accepted += 1
                if self.accepted == 1:
                    raise RuntimeError("temporary VAD error")
                return [0.2, -0.2] * 800 if samples[0] == 1.0 else None

        vad = FlakyVad()
        worker = BoundedWakeTranscriber(QueueWakeStt("Ultron"))
        detector = CompositeActivationDetector(
            clap=FakeFrameClap(TtsPlaybackGate(post_playback_ms=0)),
            wake_vad=vad,
            wake_worker=worker,
            tts_gate=TtsPlaybackGate(post_playback_ms=0),
            wake_vad_retry_seconds=0.5,
            clock=lambda: now[0],
        )
        frame = [1.0] + [0.0] * 511
        self.assertIsNone(detector.process_samples(frame, 16_000, 1.0))
        self.assertIsInstance(detector.last_wake_vad_error, RuntimeError)
        now[0] = 0.25
        self.assertIsNone(detector.process_samples(frame, 16_000, 1.25))
        self.assertEqual(vad.accepted, 1)
        now[0] = 0.6
        self.assertIsNone(detector.process_samples(frame, 16_000, 1.6))
        self.assertEqual(vad.accepted, 2)
        self.assertIsNone(detector.last_wake_vad_error)
        event = pump_for_event(detector)
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event.name, EventName.VOICE_WAKE_DETECTED)


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
    def test_off_switch_drops_queued_activation_before_routing(self) -> None:
        hud, listener, auth = FakeHud(), FakeListener(), FakeAuth()
        controller = WindowsActivationController(
            FixedSession(SessionState.UNLOCKED), hud, listener, auth
        )
        mailbox = ActivationMailbox()
        mailbox.publish(InteractionEvent(EventName.VOICE_WAKE_DETECTED, 3.0, "test"))
        outcome = ActivationDispatcher(
            mailbox, controller, activation_enabled=lambda: False
        ).dispatch_once(0)
        self.assertIsNone(outcome)
        self.assertEqual(hud.calls, 0)
        self.assertEqual(listener.calls, 0)

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
