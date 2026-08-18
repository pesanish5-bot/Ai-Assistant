from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

from voice.audio_devices import default_input_device, select_preferred_input_device
from voice.background_agent import SoundDeviceFrameSource


class _Block:
    def reshape(self, _size: int):
        return self

    def tolist(self):
        return [0.0] * 512


class _Stream:
    def __init__(self, device: int | None) -> None:
        self.device = device
        self.started = False
        self.closed = False

    def start(self) -> None:
        self.started = True

    def read(self, _size: int):
        return _Block(), False

    def stop(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class DefaultMicrophoneSwitchTests(unittest.TestCase):
    @staticmethod
    def _devices():
        return [
            {"name": "Microphone Array", "hostapi": 0, "max_input_channels": 2},
            {"name": "Headset (WF-C710N)", "hostapi": 0, "max_input_channels": 1},
            {"name": "Headphones (WF-C710N)", "hostapi": 0, "max_input_channels": 0},
            {"name": "Speakers", "hostapi": 0, "max_input_channels": 0},
        ]

    def test_headset_output_selects_matching_headset_microphone(self) -> None:
        self.assertEqual(select_preferred_input_device((0, 2), self._devices()), 1)
        self.assertEqual(select_preferred_input_device((0, 3), self._devices()), 0)

    def test_clap_input_remains_the_windows_default_capture_device(self) -> None:
        fake = types.SimpleNamespace(default=types.SimpleNamespace(device=(0, 2)))
        self.assertEqual(default_input_device(fake), 0)

    def test_default_input_switches_to_new_headset_without_restart(self) -> None:
        now = [0.0]
        streams: list[_Stream] = []
        devices = [
            {"name": "Microphone Array", "hostapi": 0, "max_input_channels": 2},
            {"name": "Speakers", "hostapi": 0, "max_input_channels": 0},
            {"name": "Headset (Demo)", "hostapi": 0, "max_input_channels": 1},
            {"name": "Headphones (Demo)", "hostapi": 0, "max_input_channels": 0},
        ]
        fake = types.SimpleNamespace(default=types.SimpleNamespace(device=(0, 1)))
        fake.query_devices = lambda: devices

        def input_stream(**kwargs):
            stream = _Stream(kwargs["device"])
            streams.append(stream)
            return stream

        fake.InputStream = input_stream
        source = SoundDeviceFrameSource(clock=lambda: now[0], device_probe_interval=1.0)
        with patch.dict(sys.modules, {"sounddevice": fake}):
            source.open()
            self.assertEqual(streams[-1].device, 0)
            fake.default.device = (2, 1)
            now[0] = 1.1
            source.read()
            self.assertEqual(streams[-1].device, 2)
            self.assertTrue(streams[0].closed)
            source.close()

    def test_explicit_input_does_not_follow_default_changes(self) -> None:
        now = [0.0]
        streams: list[_Stream] = []
        fake = types.SimpleNamespace(default=types.SimpleNamespace(device=(1, 3)))
        fake.query_devices = lambda: self._devices()
        fake.InputStream = lambda **kwargs: streams.append(_Stream(kwargs["device"])) or streams[-1]
        source = SoundDeviceFrameSource(device=7, clock=lambda: now[0])
        with patch.dict(sys.modules, {"sounddevice": fake}):
            source.open()
            fake.default.device = (5, 3)
            now[0] = 2.0
            source.read()
            self.assertEqual([stream.device for stream in streams], [7])
            source.close()


if __name__ == "__main__":
    unittest.main()
