from __future__ import annotations

import unittest
from unittest.mock import patch

from voice.adapters import LocalHudEventAdapter, LocalUltronHttpAdapter
from voice.interaction import EventName, InteractionEvent
from voice.local_endpoint import local_base_url


class LocalCoreAdapterTests(unittest.TestCase):
    def test_custom_port_reaches_the_same_core_and_hud(self) -> None:
        with patch.dict("os.environ", {"ULTRON_LOCAL_BASE_URL": "http://localhost:3010"}):
            self.assertEqual(local_base_url(), "http://localhost:3010")
            self.assertEqual(LocalUltronHttpAdapter().endpoint, "http://localhost:3010/api/ultron")
            self.assertEqual(LocalHudEventAdapter(token="x" * 32).endpoint, "http://localhost:3010/api/interaction")

    def test_custom_origin_rejects_remote_or_credentialed_urls(self) -> None:
        for value in ("http://example.com:3010", "http://user:pass@localhost:3010", "http://localhost:3010/api", "http://localhost:0"):
            with self.subTest(value=value), patch.dict("os.environ", {"ULTRON_LOCAL_BASE_URL": value}):
                with self.assertRaises(ValueError):
                    local_base_url()

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
