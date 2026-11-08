from __future__ import annotations

import json
import unittest
from unittest.mock import patch
import io
import urllib.error

from voice.write_approval import (
    LocalWriteConfirmAdapter,
    is_voice_write_approval,
)


class WriteApprovalTests(unittest.TestCase):
    def test_approval_phrases(self) -> None:
        self.assertTrue(is_voice_write_approval("yes, do it"))
        self.assertTrue(is_voice_write_approval("Yes do it!"))
        self.assertTrue(is_voice_write_approval("approve"))
        self.assertTrue(is_voice_write_approval("go ahead"))
        self.assertFalse(is_voice_write_approval("yes open youtube"))
        self.assertFalse(is_voice_write_approval("do it later"))

    def test_write_confirm_requires_loopback_token(self) -> None:
        with self.assertRaises(ValueError):
            LocalWriteConfirmAdapter(token="short")
        with self.assertRaises(ValueError):
            LocalWriteConfirmAdapter("http://192.168.1.5:3000/api/permissions/write-confirm", token="x" * 32)

    def test_approve_posts_voice_method_with_bearer(self) -> None:
        payload = {"stamped": True, "confirmation": {"id": "11111111-1111-4111-8111-111111111111"}}
        with patch(
            "urllib.request.urlopen",
            return_value=io.BytesIO(json.dumps(payload).encode()),
        ) as mocked:
            result = LocalWriteConfirmAdapter(token="x" * 32).approve(
                "11111111-1111-4111-8111-111111111111",
                speaker_verified=True,
            )
            request = mocked.call_args.args[0]
            self.assertEqual(request.get_header("Authorization"), "Bearer " + ("x" * 32))
            body = json.loads(request.data)
            self.assertEqual(body["method"], "voice")
            self.assertTrue(body["speakerVerified"])
            self.assertTrue(body["approve"])
            self.assertTrue(result["stamped"])

    def test_http_error_surfaces_server_message(self) -> None:
        error = urllib.error.HTTPError(
            "http://localhost:3000/api/permissions/write-confirm",
            400,
            "bad",
            {},
            io.BytesIO(b'{"error":"Voice approval requires speaker verification for this session."}'),
        )
        with patch("urllib.request.urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "speaker verification"):
                LocalWriteConfirmAdapter(token="x" * 32).approve(
                    "11111111-1111-4111-8111-111111111111",
                    speaker_verified=False,
                )


if __name__ == "__main__":
    unittest.main()
