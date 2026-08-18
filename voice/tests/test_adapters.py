from __future__ import annotations

import unittest

from voice.adapters import LocalHudEventAdapter, LocalUltronHttpAdapter
from voice.interaction import EventName, InteractionEvent


class LocalCoreAdapterTests(unittest.TestCase):
    def test_only_loopback_ultron_endpoint_is_allowed(self) -> None:
        self.assertEqual(
            LocalUltronHttpAdapter().endpoint,
            "http://localhost:3000/api/ultron",
        )
        with self.assertRaises(ValueError):
            LocalUltronHttpAdapter("http://192.168.1.5:3000/api/ultron")
        with self.assertRaises(ValueError):
            LocalUltronHttpAdapter("https://example.com/api/ultron")
        with self.assertRaises(ValueError):
            LocalUltronHttpAdapter("http://127.0.0.1:3000/api/auth")

    def test_hud_adapter_requires_loopback_entropy_and_safe_events(self) -> None:
        token = "x" * 32
        adapter = LocalHudEventAdapter(token=token)
        self.assertEqual(adapter.endpoint, "http://localhost:3000/api/interaction")
        with self.assertRaises(ValueError):
            LocalHudEventAdapter(token="short")
        with self.assertRaises(ValueError):
            LocalHudEventAdapter("http://192.168.1.5:3000/api/interaction", token=token)
        with self.assertRaises(ValueError):
            adapter.publish(InteractionEvent(EventName.AUTH_CHALLENGE_ISSUED, 1.0, "test"))


if __name__ == "__main__":
    unittest.main()
