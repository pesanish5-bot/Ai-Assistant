from __future__ import annotations

import unittest
import threading
from tempfile import TemporaryDirectory
from pathlib import Path

from voice.adapters import LocalHudEventAdapter
from voice.activation_control import activation_enabled
from voice.background_agent import BackgroundAgentStatus, BackgroundClapAgent, MicrophoneFrame, PerUserActivationHost
from voice.interaction import EventName, InteractionEvent
from voice.run_background import BestEffortHudSink, FanoutEventSink, write_ready_marker


class RecordingSink:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.events: list[InteractionEvent] = []

    def publish(self, event: InteractionEvent) -> None:
        self.events.append(event)
        if self.fail:
            raise ConnectionError("bridge unavailable")


class BackgroundRuntimeTests(unittest.TestCase):
    def test_tts_warmup_starts_once_only_after_voice_is_enabled(self) -> None:
        state = {"enabled": False, "warmups": 0}
        stop = threading.Event()
        warmed = threading.Event()

        class Observer:
            def start(self):
                pass

            def stop(self):
                pass

        class Agent:
            activation_pending = False
            status = BackgroundAgentStatus.READY
            detector = object()

            def run(self, stop_event):
                stop_event.wait()

            def wait_until_started(self, _timeout):
                return BackgroundAgentStatus.READY

            def close(self):
                pass

        class Dispatcher:
            def activation_enabled(self):
                return state["enabled"]

            def dispatch_once(self, timeout):
                stop.wait(timeout)

        def warmup():
            state["warmups"] += 1
            warmed.set()

        host = PerUserActivationHost(Observer(), Agent(), Dispatcher(), warmup=warmup)
        worker = threading.Thread(target=host.run, args=(stop,))
        worker.start()
        try:
            self.assertFalse(warmed.wait(0.15))
            state["enabled"] = True
            self.assertTrue(warmed.wait(1))
            state["enabled"] = False
            state["enabled"] = True
            self.assertEqual(state["warmups"], 1)
        finally:
            stop.set()
            worker.join(1)
        self.assertFalse(worker.is_alive())

    def test_activation_setting_defaults_on_and_damaged_state_fails_quiet(self) -> None:
        with TemporaryDirectory() as directory:
            control = Path(directory) / "control.json"
            self.assertTrue(activation_enabled(control))
            control.write_text('{"enabled": false}', encoding="utf-8")
            self.assertFalse(activation_enabled(control))
            control.write_text("broken", encoding="utf-8")
            self.assertFalse(activation_enabled(control))

    def test_off_switch_releases_microphone_and_prevents_activation(self) -> None:
        state = {"enabled": True}
        sources = []

        class Source:
            closed = False

            def open(self):
                pass

            def read(self):
                return MicrophoneFrame([0.0] * 512, 16_000, 1.0)

            def close(self):
                self.closed = True

        class Detector:
            resets = 0

            def process_samples(self, samples, sample_rate, timestamp):
                return None

            def reset(self):
                self.resets += 1

        def source_factory():
            source = Source()
            sources.append(source)
            return source

        detector = Detector()
        agent = BackgroundClapAgent(
            source_factory, detector, RecordingSink(),
            activation_enabled=lambda: state["enabled"],
        )
        agent.poll_once()
        self.assertEqual(agent.status, BackgroundAgentStatus.READY)
        state["enabled"] = False
        self.assertIsNone(agent.poll_once())
        self.assertTrue(sources[0].closed)
        self.assertEqual(detector.resets, 1)
        state["enabled"] = True
        agent.poll_once()
        self.assertEqual(len(sources), 2)
        agent.close()

    def test_disabled_host_reports_ready_without_opening_microphone(self) -> None:
        opened = []
        agent = BackgroundClapAgent(
            lambda: opened.append(True),
            object(),
            RecordingSink(),
            activation_enabled=lambda: False,
        )
        stop = threading.Event()
        worker = threading.Thread(target=agent.run, args=(stop,))
        worker.start()
        try:
            self.assertEqual(agent.wait_until_started(1), BackgroundAgentStatus.READY)
            self.assertEqual(opened, [])
        finally:
            stop.set()
            worker.join(1)

    def test_ready_marker_is_created_atomically(self) -> None:
        with TemporaryDirectory() as directory:
            marker = Path(directory) / "nested" / "activation.ready"
            write_ready_marker(marker)
            self.assertEqual(marker.read_text(encoding="utf-8"), "ready\n")
            self.assertEqual(list(marker.parent.glob("*.tmp")), [])

    def test_fanout_keeps_one_normalized_event_for_activation_and_hud(self) -> None:
        left = RecordingSink()
        right = RecordingSink()
        event = InteractionEvent(EventName.CLAP_DOUBLE_DETECTED, 1.0, "test", {"interval_ms": 300})
        FanoutEventSink((left, right)).publish(event)
        self.assertEqual(left.events, [event])
        self.assertEqual(right.events, [event])

    def test_hud_network_failure_is_best_effort_and_unsafe_events_are_not_sent(self) -> None:
        class FailingAdapter(LocalHudEventAdapter):
            def __init__(self) -> None:
                pass

            def publish(self, event: InteractionEvent) -> None:
                raise ConnectionError("offline")

        sink = BestEffortHudSink(FailingAdapter())
        sink.publish(InteractionEvent(EventName.VOICE_LISTENING, 2.0, "test", {"active": True}))
        self.assertIsInstance(sink.last_error, ConnectionError)
        sink.publish(InteractionEvent(EventName.AUTH_CHALLENGE_ISSUED, 3.0, "test"))
        self.assertIsInstance(sink.last_error, ConnectionError)


if __name__ == "__main__":
    unittest.main()
