from __future__ import annotations

import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

from voice.adapters import LocalHudEventAdapter
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
