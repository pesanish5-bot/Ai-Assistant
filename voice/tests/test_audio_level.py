from __future__ import annotations

import threading
import unittest

from voice.audio_level import AudioLevelPublisher
from voice.interaction import EventName


class BlockingSink:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.events = []

    def publish(self, event) -> None:
        self.events.append(event)
        self.started.set()
        self.release.wait(1)


class AudioLevelTests(unittest.TestCase):
    def test_meter_is_bounded_and_contains_no_recording_or_words(self) -> None:
        sink = BlockingSink()
        tick = [1.0]
        publisher = AudioLevelPublisher(sink, clock=lambda: tick[0])
        publisher.publish_level(0.5)
        self.assertTrue(sink.started.wait(1))
        tick[0] = 2.0
        publisher.publish_level(0.9)
        self.assertEqual(len(sink.events), 1)
        self.assertEqual(sink.events[0].name, EventName.VOICE_AUDIO_LEVEL)
        self.assertEqual(dict(sink.events[0].payload), {"level": 0.5})
        sink.release.set()
        publisher.publish_level(-1)
        self.assertEqual(len(sink.events), 1)


if __name__ == "__main__":
    unittest.main()
